//! Excel import for demand, and CSV/XLSX export for schedule runs.

use std::collections::HashMap;
use std::io::Cursor;

use actix_multipart::Multipart;
use actix_web::{get, http::header, post, web, HttpResponse};
use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use futures_util::StreamExt;
use rust_xlsxwriter::Workbook;
use serde::Serialize;

use crate::db::{new_id, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::recommendations::RecommendationOut;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(import_demand_excel)
        .service(export_run_csv)
        .service(export_run_xlsx);
}

// ---------- Import ----------

#[derive(Serialize)]
struct ImportResult {
    inserted: usize,
    skipped: usize,
    errors: Vec<String>,
}

#[post("/api/scenarios/{id}/demand/import-excel")]
async fn import_demand_excel(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    mut payload: Multipart,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();

    // Read first file field
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?;
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|e| AppError::BadRequest(format!("multipart chunk: {e}")))?;
            bytes.extend_from_slice(&data);
        }
        break; // only first field
    }
    if bytes.is_empty() {
        return Err(AppError::BadRequest("no file uploaded".into()));
    }

    // Parse XLSX
    let cursor = Cursor::new(bytes);
    let mut wb: Xlsx<_> = open_workbook_from_rs(cursor)
        .map_err(|e| AppError::BadRequest(format!("not a valid .xlsx file: {e}")))?;
    let sheet_name = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| AppError::BadRequest("workbook has no sheets".into()))?;
    let range = wb
        .worksheet_range(&sheet_name)
        .map_err(|e| AppError::BadRequest(format!("cannot read sheet '{sheet_name}': {e}")))?;

    // Build product name -> id map for this scenario
    let products = sqlx::query_as::<_, ProductRow>(
        "SELECT id, scenario_id, name FROM product WHERE scenario_id = $1",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    let mut product_by_name: HashMap<String, String> = HashMap::new();
    for p in &products {
        product_by_name.insert(p.name.to_lowercase(), p.id.clone());
    }

    // Parse header row to find column indices (case-insensitive)
    let mut iter = range.rows();
    let header = iter
        .next()
        .ok_or_else(|| AppError::BadRequest("empty sheet".into()))?;
    let mut idx: HashMap<String, usize> = HashMap::new();
    for (i, cell) in header.iter().enumerate() {
        let s = cell_as_string(cell).to_lowercase();
        if !s.is_empty() {
            idx.insert(s, i);
        }
    }
    let need = |k: &str| -> AppResult<usize> {
        idx.get(k).copied().ok_or_else(|| {
            AppError::BadRequest(format!(
                "missing required column '{k}'. Expected: Product, PeriodType, Year, PeriodIndex, Quantity, SpreadMode"
            ))
        })
    };
    let i_product = need("product")?;
    let i_period_type = need("periodtype")?;
    let i_year = need("year")?;
    let i_period_index = need("periodindex")?;
    let i_quantity = need("quantity")?;
    let i_spread = idx.get("spreadmode").copied(); // optional

    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();

    let mut tx = pool.begin().await?;

    for (row_num, row) in iter.enumerate() {
        let row_num = row_num + 2; // human-readable (1-based + header)
        if row.iter().all(|c| matches!(c, Data::Empty)) {
            continue;
        }

        let product_name = cell_as_string(row.get(i_product).unwrap_or(&Data::Empty));
        if product_name.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let Some(product_id) = product_by_name.get(&product_name.to_lowercase()).cloned() else {
            errors.push(format!("row {row_num}: unknown product '{product_name}'"));
            skipped += 1;
            continue;
        };

        let period_type = cell_as_string(row.get(i_period_type).unwrap_or(&Data::Empty))
            .trim()
            .to_lowercase();
        if !matches!(period_type.as_str(), "quarter" | "month") {
            errors.push(format!(
                "row {row_num}: PeriodType must be 'quarter' or 'month' (got '{period_type}')"
            ));
            skipped += 1;
            continue;
        }
        let year = cell_as_int(row.get(i_year).unwrap_or(&Data::Empty));
        let period_index = cell_as_int(row.get(i_period_index).unwrap_or(&Data::Empty));
        let quantity = cell_as_int(row.get(i_quantity).unwrap_or(&Data::Empty));
        let spread_mode = i_spread
            .and_then(|i| row.get(i))
            .map(|c| cell_as_string(c).trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "even".to_string());
        if !["even", "start", "end"].contains(&spread_mode.as_str()) {
            errors.push(format!(
                "row {row_num}: SpreadMode must be even/start/end (got '{spread_mode}')"
            ));
            skipped += 1;
            continue;
        }

        if year <= 0 || quantity <= 0 || period_index <= 0 {
            errors.push(format!(
                "row {row_num}: year/quantity/period_index must be positive integers"
            ));
            skipped += 1;
            continue;
        }

        sqlx::query("INSERT INTO demand (id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(new_id())
            .bind(&scenario_id)
            .bind(&product_id)
            .bind(&period_type)
            .bind(year)
            .bind(period_index)
            .bind(quantity)
            .bind(&spread_mode)
            .execute(&mut *tx)
            .await?;
        inserted += 1;
    }

    tx.commit().await?;

    Ok(HttpResponse::Ok().json(ImportResult {
        inserted,
        skipped,
        errors,
    }))
}

fn cell_as_string(c: &Data) -> String {
    match c {
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // Avoid trailing ".0" for ints
            if f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        _ => String::new(),
    }
}

fn cell_as_int(c: &Data) -> i64 {
    match c {
        Data::Int(i) => *i,
        Data::Float(f) => *f as i64,
        Data::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

// ---------- Export ----------

async fn load_run(
    pool: &Pool,
    run_id: &str,
) -> AppResult<(ScheduleRun, Vec<ScheduledUnit>, RecommendationOut)> {
    let run = sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable FROM schedule_run WHERE id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("run {run_id}")))?;

    let units = sqlx::query_as::<_, ScheduledUnit>(
        "SELECT id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late FROM scheduled_unit WHERE run_id = $1 ORDER BY due_date",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;

    let recs = sqlx::query_as::<_, RecommendationRow>(
        "SELECT id, run_id, rec_type, payload_json FROM recommendation WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    let mut recommendation = RecommendationOut::default();
    for r in recs {
        match r.rec_type.as_str() {
            "bays_needed" => {
                recommendation.bays_needed = serde_json::from_str(&r.payload_json).ok().flatten();
            }
            "uniform_lt_pct" => {
                recommendation.uniform_lt_pct =
                    serde_json::from_str(&r.payload_json).ok().flatten();
            }
            "per_product_lt" => {
                recommendation.per_product_lt = serde_json::from_str(&r.payload_json)
                    .ok()
                    .unwrap_or_default();
            }
            _ => {}
        }
    }

    Ok((run, units, recommendation))
}

#[get("/api/runs/{id}/export.csv")]
async fn export_run_csv(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let run_id = path.into_inner();
    let (_run, units, _rec) = load_run(pool.get_ref(), &run_id).await?;

    // Resolve names for product/factory
    let (product_names, factory_names) = load_name_maps(pool.get_ref()).await?;

    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr.write_record([
        "serial",
        "demand_id",
        "product",
        "factory",
        "bay",
        "required_start",
        "due_date",
        "status",
        "late",
        "orig_due_date",
    ])
    .map_err(|e| AppError::Internal(format!("csv write: {e}")))?;
    for u in &units {
        wtr.write_record([
            u.serial.as_deref().unwrap_or(""),
            u.demand_id.as_str(),
            product_names
                .get(&u.product_id)
                .map(String::as_str)
                .unwrap_or("(unknown)"),
            u.factory_id
                .as_deref()
                .and_then(|f| factory_names.get(f).map(String::as_str))
                .unwrap_or(""),
            u.bay_index
                .map(|b| (b + 1).to_string())
                .unwrap_or_default()
                .as_str(),
            u.required_start.as_str(),
            u.due_date.as_str(),
            u.status.as_str(),
            if u.is_late { "yes" } else { "" },
            u.orig_due_date.as_deref().unwrap_or(""),
        ])
        .map_err(|e| AppError::Internal(format!("csv write: {e}")))?;
    }
    let data = wtr
        .into_inner()
        .map_err(|e| AppError::Internal(format!("csv finalize: {e}")))?;

    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/csv"))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"factoryplan-{run_id}.csv\""),
        ))
        .body(data))
}

#[get("/api/runs/{id}/export.xlsx")]
async fn export_run_xlsx(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse> {
    let run_id = path.into_inner();
    let (run, units, rec) = load_run(pool.get_ref(), &run_id).await?;
    let (product_names, factory_names) = load_name_maps(pool.get_ref()).await?;

    let mut wb = Workbook::new();

    // Sheet 1: Summary
    {
        let s = wb.add_worksheet().set_name("Summary").map_err(xerr)?;
        s.write_string(0, 0, "Run").map_err(xerr)?;
        s.write_string(0, 1, &run.id).map_err(xerr)?;
        s.write_string(1, 0, "Run at").map_err(xerr)?;
        s.write_string(1, 1, &run.run_at).map_err(xerr)?;
        s.write_string(2, 0, "Total demand").map_err(xerr)?;
        s.write_number(2, 1, run.total_demand as f64)
            .map_err(xerr)?;
        s.write_string(3, 0, "Shipped on time").map_err(xerr)?;
        s.write_number(3, 1, run.shipped_on_time as f64)
            .map_err(xerr)?;
        s.write_string(4, 0, "Unshippable").map_err(xerr)?;
        s.write_number(4, 1, run.unshippable as f64).map_err(xerr)?;
    }

    // Sheet 2: Units
    {
        let s = wb.add_worksheet().set_name("Units").map_err(xerr)?;
        let header_row = [
            "Serial",
            "Product",
            "Factory",
            "Bay",
            "Required start",
            "Due date",
            "Status",
            "Late",
        ];
        for (i, h) in header_row.iter().enumerate() {
            s.write_string(0, i as u16, *h).map_err(xerr)?;
        }
        for (row, u) in units.iter().enumerate() {
            let r = (row + 1) as u32;
            s.write_string(r, 0, u.serial.as_deref().unwrap_or(""))
                .map_err(xerr)?;
            s.write_string(
                r,
                1,
                product_names
                    .get(&u.product_id)
                    .map(String::as_str)
                    .unwrap_or("(unknown)"),
            )
            .map_err(xerr)?;
            s.write_string(
                r,
                2,
                u.factory_id
                    .as_deref()
                    .and_then(|f| factory_names.get(f).map(String::as_str))
                    .unwrap_or(""),
            )
            .map_err(xerr)?;
            if let Some(b) = u.bay_index {
                s.write_number(r, 3, (b + 1) as f64).map_err(xerr)?;
            }
            s.write_string(r, 4, &u.required_start).map_err(xerr)?;
            s.write_string(r, 5, &u.due_date).map_err(xerr)?;
            s.write_string(r, 6, &u.status).map_err(xerr)?;
            s.write_string(r, 7, if u.is_late { "yes" } else { "" })
                .map_err(xerr)?;
        }
    }

    // Sheet 3: Recommendations
    {
        let s = wb
            .add_worksheet()
            .set_name("Recommendations")
            .map_err(xerr)?;
        let mut row = 0u32;
        if let Some(b) = &rec.bays_needed {
            s.write_string(row, 0, "Bays needed").map_err(xerr)?;
            s.write_number(row, 1, b.bays_to_add as f64).map_err(xerr)?;
            s.write_string(row, 2, b.suggested_factory_name.as_deref().unwrap_or(""))
                .map_err(xerr)?;
            row += 1;
        }
        if let Some(u) = &rec.uniform_lt_pct {
            s.write_string(row, 0, "Uniform LT reduction %")
                .map_err(xerr)?;
            s.write_number(row, 1, u.reduction_pct).map_err(xerr)?;
            row += 1;
        }
        if !rec.per_product_lt.is_empty() {
            row += 1;
            s.write_string(row, 0, "Per-product LT targets")
                .map_err(xerr)?;
            row += 1;
            s.write_string(row, 0, "Product").map_err(xerr)?;
            s.write_string(row, 1, "Current LT (days)").map_err(xerr)?;
            s.write_string(row, 2, "Target LT (days)").map_err(xerr)?;
            row += 1;
            for p in &rec.per_product_lt {
                s.write_string(row, 0, &p.product_name).map_err(xerr)?;
                s.write_number(row, 1, p.current_lead_time_days as f64)
                    .map_err(xerr)?;
                s.write_number(row, 2, p.target_lead_time_days as f64)
                    .map_err(xerr)?;
                row += 1;
            }
        }
        if row == 0 {
            s.write_string(0, 0, "No recommendations — all demand ships on time.")
                .map_err(xerr)?;
        }
    }

    let data = wb
        .save_to_buffer()
        .map_err(|e| AppError::Internal(format!("xlsx save: {e}")))?;

    Ok(HttpResponse::Ok()
        .insert_header((
            header::CONTENT_TYPE,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"factoryplan-{run_id}.xlsx\""),
        ))
        .body(data))
}

fn xerr(e: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Internal(format!("xlsx: {e}"))
}

async fn load_name_maps(
    pool: &Pool,
) -> AppResult<(HashMap<String, String>, HashMap<String, String>)> {
    let products = sqlx::query_as::<_, ProductRow>("SELECT id, scenario_id, name FROM product")
        .fetch_all(pool)
        .await?;
    let factories = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory",
    )
    .fetch_all(pool)
    .await?;
    let mut pm = HashMap::new();
    for p in products {
        pm.insert(p.id, p.name);
    }
    let mut fm = HashMap::new();
    for f in factories {
        fm.insert(f.id, f.name);
    }
    Ok((pm, fm))
}

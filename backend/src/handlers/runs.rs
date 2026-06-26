use actix_web::{get, post, web, HttpResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::db::{new_id, now_iso, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::recommendations::{compute_recommendations, RecommendationOut};
use crate::scheduling::{
    generate_serials, run_schedule_mode, run_schedule_with_lt_mode, BayAssignment, BayCountInput,
    DemandInput, FactoryAllocationInput, FactoryInput, FactoryLeadTimeInput, LeadTimeInput,
    ProductInput, ScheduleInput, ScheduleOutput, UnitStatus,
};

/// Query params for a run. `optimize=utilization` packs work to maximize bay
/// utilization (leaving unneeded bays empty); anything else load-balances.
#[derive(Debug, Deserialize)]
struct RunQuery {
    #[serde(default)]
    optimize: Option<String>,
}

impl RunQuery {
    fn assignment(&self) -> BayAssignment {
        match self.optimize.as_deref() {
            Some("utilization") => BayAssignment::MaximizeUtilization,
            _ => BayAssignment::BalanceLoad,
        }
    }
}

const MAX_SYNC_RECOMMENDATION_UNITS: usize = 500;

/// Parse a stored serial-list (newline-separated, e.g. pasted from Excel) into
/// positional entries. Internal blanks are kept (they map to no serial);
/// trailing blank lines are dropped.
fn parse_serial_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = raw
        .replace('\r', "\n")
        .split('\n')
        .map(|s| s.trim().to_string())
        .collect();
    while out.last().map(|s| s.is_empty()).unwrap_or(false) {
        out.pop();
    }
    out
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(run_scenario).service(get_run);
}

#[derive(Serialize)]
pub struct RunResponse {
    pub run: ScheduleRun,
    pub units: Vec<ScheduledUnit>,
    pub recommendation: RecommendationOut,
    pub quarter_misses: Vec<QuarterMissRow>,
    #[serde(default)]
    pub alternatives: Vec<RunAlternative>,
}

#[derive(Serialize)]
pub struct RunAlternative {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub total_demand: i64,
    pub shipped_on_time: i64,
    pub shipped_late: i64,
    pub unshippable: i64,
    pub units: Vec<ScheduledUnit>,
}

pub(crate) async fn load_schedule_input(
    pool: &Pool,
    scenario_id: &str,
) -> AppResult<ScheduleInput> {
    // factories + per-quarter bay-count overrides
    let factory_rows = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    let mut factories: Vec<FactoryInput> = Vec::with_capacity(factory_rows.len());
    for f in factory_rows {
        let bcs = sqlx::query_as::<_, BayCountRow>(
            "SELECT id, factory_id, year, quarter, bays FROM factory_bay_count WHERE factory_id = $1",
        )
        .bind(&f.id)
        .fetch_all(pool)
        .await?;
        factories.push(FactoryInput {
            id: f.id,
            name: f.name,
            bays: f.bays,
            changeover_days: f.changeover_days,
            bay_counts_by_quarter: bcs
                .into_iter()
                .map(|b| BayCountInput {
                    year: b.year,
                    quarter: b.quarter,
                    bays: b.bays,
                })
                .collect(),
        });
    }

    // products + lead times
    let products_rows = sqlx::query_as::<_, ProductRow>(
        "SELECT id, scenario_id, name FROM product WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    let mut products: Vec<ProductInput> = Vec::with_capacity(products_rows.len());
    for p in products_rows {
        let lts = sqlx::query_as::<_, LeadTimeRow>(
            "SELECT id, product_id, year, quarter, lead_time_days FROM product_lead_time WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        let flts = sqlx::query_as::<_, FactoryLeadTimeRow>(
            "SELECT id, product_id, factory_id, year, quarter, lead_time_days FROM product_factory_lead_time WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        let allocs = sqlx::query_as::<_, FactoryAllocationRow>(
            "SELECT id, product_id, factory_id, year, quarter, allocation_pct FROM product_factory_allocation WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        products.push(ProductInput {
            id: p.id,
            name: p.name,
            lead_times: lts
                .into_iter()
                .map(|l| LeadTimeInput {
                    year: l.year,
                    quarter: l.quarter,
                    lead_time_days: l.lead_time_days,
                })
                .collect(),
            factory_lead_times: flts
                .into_iter()
                .map(|l| FactoryLeadTimeInput {
                    factory_id: l.factory_id,
                    year: l.year,
                    quarter: l.quarter,
                    lead_time_days: l.lead_time_days,
                })
                .collect(),
            factory_allocations: allocs
                .into_iter()
                .map(|a| FactoryAllocationInput {
                    factory_id: a.factory_id,
                    year: a.year,
                    quarter: a.quarter,
                    allocation_pct: a.allocation_pct,
                })
                .collect(),
        });
    }

    // demand
    let demand_rows = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1 ORDER BY year, period_index",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;

    Ok(ScheduleInput {
        factories,
        products,
        demand: demand_rows
            .into_iter()
            .map(|d| DemandInput {
                id: d.id,
                product_id: d.product_id,
                period_type: d.period_type,
                year: d.year,
                period_index: d.period_index,
                quantity: d.quantity,
                spread_mode: d.spread_mode,
            })
            .collect(),
    })
}

#[post("/api/scenarios/{id}/run")]
async fn run_scenario(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    query: web::Query<RunQuery>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let mode = query.assignment();

    // Verify scenario exists
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM scenario WHERE id = $1")
        .bind(&scenario_id)
        .fetch_optional(pool.get_ref())
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("scenario {scenario_id}")));
    }

    let input = load_schedule_input(pool.get_ref(), &scenario_id).await?;
    let output = run_schedule_mode(&input, mode);

    // Resolve per-unit serials from each demand row's serial config.
    let demand_rows = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    let serial_for = assign_serials(&demand_rows, &output.units);

    // Keep the normal run fast: recommendations are global what-ifs and can be
    // expensive because they rerun the scheduler many times. Large overloaded
    // scenarios still save and return the schedule; users can inspect backlog
    // without waiting for hundreds of what-if simulations.
    let recommendation =
        if output.unshippable > 0 && output.total_demand <= MAX_SYNC_RECOMMENDATION_UNITS {
            compute_recommendations(&input, &output, mode)
        } else {
            RecommendationOut::default()
        };

    // Persist
    let run_id = new_id();
    let alternatives = build_alternatives(&input, &recommendation, mode, &demand_rows, &run_id);
    let run_at = now_iso();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO schedule_run (id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(&run_id)
        .bind(&scenario_id)
        .bind(&run_at)
        .bind(output.total_demand as i64)
        .bind(output.shipped_on_time as i64)
        .bind(output.shipped_late as i64)
        .bind(output.unshippable as i64)
        .execute(&mut *tx)
        .await?;

    for (i, u) in output.units.iter().enumerate() {
        // status stays 'shipped'|'unshippable'; lateness is a separate flag.
        let (status, is_late) = match u.status {
            UnitStatus::Shipped => ("shipped", false),
            UnitStatus::Late => ("shipped", true),
            UnitStatus::Unshippable => ("unshippable", false),
        };
        sqlx::query("INSERT INTO scheduled_unit (id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")
            .bind(new_id())
            .bind(&run_id)
            .bind(&u.demand_id)
            .bind(&u.product_id)
            .bind(u.factory_id.as_deref())
            .bind(u.bay_index)
            .bind(u.required_start.to_string())
            .bind(u.due_date.to_string())
            .bind(status)
            .bind(serial_for.get(i).cloned().flatten())
            .bind(u.orig_due_date.to_string())
            .bind(is_late)
            .execute(&mut *tx)
            .await?;
    }

    // Persist per-quarter miss counts.
    for m in &output.quarter_misses {
        sqlx::query("INSERT INTO quarter_miss (id, run_id, year, quarter, missed_count) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&run_id)
            .bind(m.year)
            .bind(m.quarter)
            .bind(m.count)
            .execute(&mut *tx)
            .await?;
    }

    // Persist recommendations (one row per type, payload JSON)
    persist_rec(&mut tx, &run_id, "bays_needed", &recommendation.bays_needed).await?;
    persist_rec(
        &mut tx,
        &run_id,
        "uniform_lt_pct",
        &recommendation.uniform_lt_pct,
    )
    .await?;
    persist_rec(
        &mut tx,
        &run_id,
        "per_product_lt",
        &recommendation.per_product_lt,
    )
    .await?;

    tx.commit().await?;

    let run = ScheduleRun {
        id: run_id.clone(),
        scenario_id: scenario_id.clone(),
        run_at,
        total_demand: output.total_demand as i64,
        shipped_on_time: output.shipped_on_time as i64,
        shipped_late: output.shipped_late as i64,
        unshippable: output.unshippable as i64,
    };

    let units = load_units(pool.get_ref(), &run_id).await?;
    let quarter_misses = load_quarter_misses(pool.get_ref(), &run_id).await?;

    Ok(HttpResponse::Ok().json(RunResponse {
        run,
        units,
        recommendation,
        quarter_misses,
        alternatives,
    }))
}

#[get("/api/runs/{id}")]
async fn get_run(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let run_id = path.into_inner();
    let run = sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable FROM schedule_run WHERE id = $1",
    )
    .bind(&run_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("run {run_id}")))?;

    let units = load_units(pool.get_ref(), &run_id).await?;

    let recs = sqlx::query_as::<_, RecommendationRow>(
        "SELECT id, run_id, rec_type, payload_json FROM recommendation WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_all(pool.get_ref())
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

    let quarter_misses = load_quarter_misses(pool.get_ref(), &run_id).await?;

    Ok(HttpResponse::Ok().json(RunResponse {
        run,
        units,
        recommendation,
        quarter_misses,
        alternatives: vec![],
    }))
}

fn build_alternatives(
    input: &ScheduleInput,
    recommendation: &RecommendationOut,
    mode: BayAssignment,
    demand_rows: &[Demand],
    base_run_id: &str,
) -> Vec<RunAlternative> {
    let mut out = Vec::new();

    if let Some(b) = &recommendation.bays_needed {
        if let Some(target_id) = &b.suggested_factory_id {
            let mut trial = input.clone();
            for f in trial.factories.iter_mut() {
                if &f.id == target_id {
                    f.bays += b.bays_to_add;
                    break;
                }
            }
            let alt = run_schedule_mode(&trial, mode);
            out.push(alt_response(
                "bays",
                "Add bays",
                format!(
                    "Add {} bay{} to {}",
                    b.bays_to_add,
                    if b.bays_to_add == 1 { "" } else { "s" },
                    b.suggested_factory_name
                        .as_deref()
                        .unwrap_or("the busiest factory")
                ),
                &format!("{base_run_id}:alt:bays"),
                &alt,
                demand_rows,
            ));
        }
    }

    if let Some(u) = &recommendation.uniform_lt_pct {
        let scale = (1.0 - (u.reduction_pct / 100.0)).max(0.01);
        let alt = run_schedule_with_lt_mode(
            input,
            |_pid, lt| ((lt as f64) * scale).round().max(1.0) as i64,
            mode,
        );
        out.push(alt_response(
            "ct",
            "Reduce cycle time",
            format!("Reduce all cycle times by {:.1}%", u.reduction_pct),
            &format!("{base_run_id}:alt:ct"),
            &alt,
            demand_rows,
        ));
    }

    out
}

fn alt_response(
    kind: &str,
    label: &str,
    description: String,
    run_id: &str,
    output: &ScheduleOutput,
    demand_rows: &[Demand],
) -> RunAlternative {
    let serial_for = assign_serials(demand_rows, &output.units);
    RunAlternative {
        kind: kind.to_string(),
        label: label.to_string(),
        description,
        total_demand: output.total_demand as i64,
        shipped_on_time: output.shipped_on_time as i64,
        shipped_late: output.shipped_late as i64,
        unshippable: output.unshippable as i64,
        units: output_units_to_api(run_id, output, &serial_for),
    }
}

fn output_units_to_api(
    run_id: &str,
    output: &ScheduleOutput,
    serial_for: &[Option<String>],
) -> Vec<ScheduledUnit> {
    output
        .units
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let (status, is_late) = match u.status {
                UnitStatus::Shipped => ("shipped", false),
                UnitStatus::Late => ("shipped", true),
                UnitStatus::Unshippable => ("unshippable", false),
            };
            ScheduledUnit {
                id: format!("{run_id}:{i}"),
                run_id: run_id.to_string(),
                demand_id: u.demand_id.clone(),
                product_id: u.product_id.clone(),
                factory_id: u.factory_id.clone(),
                bay_index: u.bay_index,
                required_start: u.required_start.to_string(),
                due_date: u.due_date.to_string(),
                status: status.to_string(),
                serial: serial_for.get(i).cloned().flatten(),
                orig_due_date: Some(u.orig_due_date.to_string()),
                is_late,
            }
        })
        .collect()
}

async fn load_units(pool: &Pool, run_id: &str) -> AppResult<Vec<ScheduledUnit>> {
    let units = sqlx::query_as::<_, ScheduledUnit>(
        "SELECT id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late FROM scheduled_unit WHERE run_id = $1 ORDER BY due_date",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    Ok(units)
}

async fn load_quarter_misses(pool: &Pool, run_id: &str) -> AppResult<Vec<QuarterMissRow>> {
    let rows = sqlx::query_as::<_, QuarterMissRow>(
        "SELECT id, run_id, year, quarter, missed_count FROM quarter_miss WHERE run_id = $1 ORDER BY year, quarter",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Map each output unit to its serial. Serials are generated per demand row and
/// assigned positionally in due-date order (matching the explosion order).
fn assign_serials(
    demand_rows: &[Demand],
    units: &[crate::scheduling::ScheduledUnitOut],
) -> Vec<Option<String>> {
    let mut serials_by_demand: HashMap<&str, Vec<Option<String>>> = HashMap::new();
    for d in demand_rows {
        let list = d
            .serial_list
            .as_deref()
            .map(parse_serial_list)
            .unwrap_or_default();
        let serials = generate_serials(
            &d.serial_mode,
            d.serial_start.as_deref(),
            &list,
            d.quantity.max(0) as usize,
        );
        serials_by_demand.insert(d.id.as_str(), serials);
    }

    let mut idxs_by_demand: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        idxs_by_demand
            .entry(u.demand_id.as_str())
            .or_default()
            .push(i);
    }

    let mut serial_for = vec![None; units.len()];
    for (did, mut idxs) in idxs_by_demand {
        idxs.sort_by(|&a, &b| units[a].due_date.cmp(&units[b].due_date));
        if let Some(serials) = serials_by_demand.get(did) {
            for (k, &i) in idxs.iter().enumerate() {
                serial_for[i] = serials.get(k).cloned().flatten();
            }
        }
    }
    serial_for
}

async fn persist_rec<T: serde::Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: &str,
    rec_type: &str,
    payload: &T,
) -> AppResult<()> {
    let json = serde_json::to_string(payload)
        .map_err(|e| AppError::Internal(format!("serialize {rec_type}: {e}")))?;
    sqlx::query(
        "INSERT INTO recommendation (id, run_id, rec_type, payload_json) VALUES ($1, $2, $3, $4)",
    )
    .bind(new_id())
    .bind(run_id)
    .bind(rec_type)
    .bind(&json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

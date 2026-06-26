use actix_web::{delete, get, post, put, web, HttpResponse};

use crate::db::{new_id, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_demand)
        .service(create_demand)
        .service(update_demand)
        .service(delete_demand);
}

fn validate_demand_inputs(
    period_type: &str,
    period_index: i64,
    quantity: i64,
    spread_mode: &str,
) -> Result<(), AppError> {
    match period_type {
        "month" => {
            if !(1..=12).contains(&period_index) {
                return Err(AppError::BadRequest(format!(
                    "period_index must be 1..=12 for month (got {period_index})"
                )));
            }
        }
        "quarter" => {
            if !(1..=4).contains(&period_index) {
                return Err(AppError::BadRequest(format!(
                    "period_index must be 1..=4 for quarter (got {period_index})"
                )));
            }
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "period_type must be 'month' or 'quarter' (got '{other}')"
            )));
        }
    }
    if quantity <= 0 {
        return Err(AppError::BadRequest("quantity must be > 0".into()));
    }
    if !["even", "start", "end"].contains(&spread_mode) {
        return Err(AppError::BadRequest(format!(
            "spread_mode must be even/start/end (got '{spread_mode}')"
        )));
    }
    Ok(())
}

fn validate_serial_mode(serial_mode: &str) -> Result<(), AppError> {
    if !["none", "sequence", "list"].contains(&serial_mode) {
        return Err(AppError::BadRequest(format!(
            "serial_mode must be none/sequence/list (got '{serial_mode}')"
        )));
    }
    Ok(())
}

async fn ensure_scenario_exists(pool: &Pool, scenario_id: &str) -> AppResult<()> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1::BIGINT FROM scenario WHERE id = $1")
        .bind(scenario_id)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("scenario {scenario_id}")));
    }
    Ok(())
}

async fn ensure_product_in_scenario(
    pool: &Pool,
    product_id: &str,
    scenario_id: &str,
) -> AppResult<()> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1::BIGINT FROM product WHERE id = $1 AND scenario_id = $2")
            .bind(product_id)
            .bind(scenario_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(AppError::BadRequest(format!(
            "product {product_id} does not belong to scenario {scenario_id}"
        )));
    }
    Ok(())
}

#[get("/api/scenarios/{id}/demand")]
async fn list_demand(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let rows = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1 ORDER BY year, period_index",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

#[post("/api/scenarios/{id}/demand")]
async fn create_demand(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<CreateDemand>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    validate_demand_inputs(
        &body.period_type,
        body.period_index,
        body.quantity,
        &body.spread_mode,
    )?;
    validate_serial_mode(&body.serial_mode)?;
    ensure_scenario_exists(pool.get_ref(), &scenario_id).await?;
    ensure_product_in_scenario(pool.get_ref(), &body.product_id, &scenario_id).await?;

    let id = new_id();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO demand (id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)")
        .bind(&id)
        .bind(&scenario_id)
        .bind(&body.product_id)
        .bind(&body.period_type)
        .bind(body.year)
        .bind(body.period_index)
        .bind(body.quantity)
        .bind(&body.spread_mode)
        .bind(&body.serial_mode)
        .bind(&body.serial_start)
        .bind(&body.serial_list)
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(HttpResponse::Created().json(row))
}

#[put("/api/demand/{id}")]
async fn update_demand(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<UpdateDemand>,
) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    validate_demand_inputs(
        &body.period_type,
        body.period_index,
        body.quantity,
        &body.spread_mode,
    )?;
    validate_serial_mode(&body.serial_mode)?;

    let scenario_id: Option<String> =
        sqlx::query_scalar("SELECT scenario_id FROM demand WHERE id = $1")
            .bind(&id)
            .fetch_optional(pool.get_ref())
            .await?;
    let scenario_id = scenario_id.ok_or_else(|| AppError::NotFound(format!("demand {id}")))?;
    ensure_product_in_scenario(pool.get_ref(), &body.product_id, &scenario_id).await?;

    let mut tx = pool.begin().await?;
    let res = sqlx::query("UPDATE demand SET product_id = $1, period_type = $2, year = $3, period_index = $4, quantity = $5, spread_mode = $6, serial_mode = $7, serial_start = $8, serial_list = $9 WHERE id = $10")
        .bind(&body.product_id)
        .bind(&body.period_type)
        .bind(body.year)
        .bind(body.period_index)
        .bind(body.quantity)
        .bind(&body.spread_mode)
        .bind(&body.serial_mode)
        .bind(&body.serial_start)
        .bind(&body.serial_list)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("demand {id}")));
    }
    let row = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(HttpResponse::Ok().json(row))
}

#[delete("/api/demand/{id}")]
async fn delete_demand(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    let res = sqlx::query("DELETE FROM demand WHERE id = $1")
        .bind(&id)
        .execute(pool.get_ref())
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("demand {id}")));
    }
    Ok(HttpResponse::NoContent().finish())
}

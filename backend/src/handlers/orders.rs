use actix_web::{delete, get, put, web, HttpResponse};
use serde::Serialize;

use crate::db::{new_id, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AnchorStatus {
    pub utid: String,
    pub target_due_date: String,
    pub required_start: String,
    pub scheduled_finish: String,
    pub is_late: bool,
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_orders)
        .service(list_anchor_statuses)
        .service(replace_orders)
        .service(remove_anchor);
}

#[get("/api/scenarios/{id}/orders")]
async fn list_orders(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let rows = sqlx::query_as::<_, ScenarioOrder>(
        "SELECT id, scenario_id, utid, build_type, customer, cycle_time_days, sort_order, due_date, anchor_factory_id FROM scenario_order WHERE scenario_id = $1 ORDER BY sort_order, utid",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

#[get("/api/scenarios/{id}/orders/anchor-statuses")]
async fn list_anchor_statuses(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let rows = sqlx::query_as::<_, AnchorStatus>(
        r#"
        SELECT
            su.serial AS utid,
            COALESCE(su.orig_due_date, su.due_date) AS target_due_date,
            su.required_start,
            su.due_date AS scheduled_finish,
            su.is_late
        FROM scheduled_unit su
        JOIN schedule_run sr ON sr.id = su.run_id
        WHERE sr.scenario_id = $1
          AND su.is_anchored = TRUE
          AND su.serial IS NOT NULL
          AND sr.run_at = (
              SELECT MAX(run_at)
              FROM schedule_run
              WHERE scenario_id = $1
          )
        "#,
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

#[put("/api/scenarios/{id}/orders")]
async fn replace_orders(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<ReplaceOrders>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let mut cleaned: Vec<(&OrderInput, i64)> = Vec::new();
    for (i, o) in body.orders.iter().enumerate() {
        if o.utid.trim().is_empty() {
            return Err(AppError::BadRequest(format!(
                "orders[{i}].utid is required"
            )));
        }
        if o.customer.trim().is_empty() {
            return Err(AppError::BadRequest(format!(
                "orders[{i}].customer is required"
            )));
        }
        if o.cycle_time_days <= 0 {
            return Err(AppError::BadRequest(format!(
                "orders[{i}].cycle_time_days must be > 0"
            )));
        }
        cleaned.push((o, i as i64));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM scenario_order WHERE scenario_id = $1")
        .bind(&scenario_id)
        .execute(&mut *tx)
        .await?;
    for (o, sort_order) in cleaned {
        sqlx::query("INSERT INTO scenario_order (id, scenario_id, utid, build_type, customer, cycle_time_days, sort_order, due_date, anchor_factory_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
            .bind(new_id())
            .bind(&scenario_id)
            .bind(o.utid.trim())
            .bind(o.build_type.trim())
            .bind(o.customer.trim())
            .bind(o.cycle_time_days)
            .bind(sort_order)
            .bind(&o.due_date)
            .bind(o.anchor_factory_id.as_ref().filter(|id| !id.trim().is_empty()))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let rows = sqlx::query_as::<_, ScenarioOrder>(
        "SELECT id, scenario_id, utid, build_type, customer, cycle_time_days, sort_order, due_date, anchor_factory_id FROM scenario_order WHERE scenario_id = $1 ORDER BY sort_order, utid",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

#[delete("/api/scenarios/{scenario_id}/orders/{utid}/anchor")]
async fn remove_anchor(
    pool: web::Data<Pool>,
    path: web::Path<(String, String)>,
) -> AppResult<HttpResponse> {
    let (scenario_id, utid) = path.into_inner();

    sqlx::query("UPDATE scenario_order SET due_date = NULL, anchor_factory_id = NULL WHERE scenario_id = $1 AND utid = $2")
        .bind(&scenario_id)
        .bind(&utid)
        .execute(pool.get_ref())
        .await?;

    let rows = sqlx::query_as::<_, ScenarioOrder>(
        "SELECT id, scenario_id, utid, build_type, customer, cycle_time_days, sort_order, due_date, anchor_factory_id FROM scenario_order WHERE scenario_id = $1 ORDER BY sort_order, utid",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

use actix_web::{delete, get, post, put, web, HttpResponse};

use crate::db::{new_id, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_factories)
        .service(create_factory)
        .service(update_factory)
        .service(delete_factory);
}

async fn bay_counts_for(pool: &Pool, factory_id: &str) -> Result<Vec<BayCountRow>, sqlx::Error> {
    sqlx::query_as::<_, BayCountRow>(
        "SELECT id, factory_id, year, quarter, bays FROM factory_bay_count WHERE factory_id = $1 ORDER BY year, quarter",
    )
    .bind(factory_id)
    .fetch_all(pool)
    .await
}

fn validate_bay_counts(items: &[BayCountInput]) -> Result<(), AppError> {
    for c in items {
        if !(1..=4).contains(&c.quarter) {
            return Err(AppError::BadRequest(format!(
                "quarter must be 1..=4 (got {})",
                c.quarter
            )));
        }
        if c.bays < 0 {
            return Err(AppError::BadRequest(format!(
                "bay_counts.bays must be >= 0 (got {})",
                c.bays
            )));
        }
    }
    Ok(())
}

async fn as_with_bays(pool: &Pool, f: Factory) -> AppResult<FactoryWithBayCounts> {
    let bay_counts = bay_counts_for(pool, &f.id).await?;
    Ok(FactoryWithBayCounts {
        id: f.id,
        scenario_id: f.scenario_id,
        name: f.name,
        bays: f.bays,
        changeover_days: f.changeover_days,
        bay_counts,
    })
}

#[get("/api/scenarios/{id}/factories")]
async fn list_factories(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let rows = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    let mut out: Vec<FactoryWithBayCounts> = Vec::with_capacity(rows.len());
    for f in rows {
        out.push(as_with_bays(pool.get_ref(), f).await?);
    }
    Ok(HttpResponse::Ok().json(out))
}

#[post("/api/scenarios/{id}/factories")]
async fn create_factory(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<CreateFactory>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if body.bays < 0 {
        return Err(AppError::BadRequest("bays must be >= 0".into()));
    }
    if body.changeover_days < 0 {
        return Err(AppError::BadRequest("changeover_days must be >= 0".into()));
    }
    validate_bay_counts(&body.bay_counts)?;
    let id = new_id();

    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO factory (id, scenario_id, name, bays, changeover_days) VALUES ($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(&scenario_id)
        .bind(name)
        .bind(body.bays)
        .bind(body.changeover_days)
        .execute(&mut *tx)
        .await?;
    for c in &body.bay_counts {
        sqlx::query("INSERT INTO factory_bay_count (id, factory_id, year, quarter, bays) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&id)
            .bind(c.year)
            .bind(c.quarter)
            .bind(c.bays)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let row = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;
    Ok(HttpResponse::Created().json(as_with_bays(pool.get_ref(), row).await?))
}

#[put("/api/factories/{id}")]
async fn update_factory(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<UpdateFactory>,
) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if body.bays < 0 {
        return Err(AppError::BadRequest("bays must be >= 0".into()));
    }
    if body.changeover_days < 0 {
        return Err(AppError::BadRequest("changeover_days must be >= 0".into()));
    }
    validate_bay_counts(&body.bay_counts)?;

    let mut tx = pool.begin().await?;
    let res =
        sqlx::query("UPDATE factory SET name = $1, bays = $2, changeover_days = $3 WHERE id = $4")
            .bind(name)
            .bind(body.bays)
            .bind(body.changeover_days)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("factory {id}")));
    }

    // Replace per-quarter overrides wholesale
    sqlx::query("DELETE FROM factory_bay_count WHERE factory_id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for c in &body.bay_counts {
        sqlx::query("INSERT INTO factory_bay_count (id, factory_id, year, quarter, bays) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&id)
            .bind(c.year)
            .bind(c.quarter)
            .bind(c.bays)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let row = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(as_with_bays(pool.get_ref(), row).await?))
}

#[delete("/api/factories/{id}")]
async fn delete_factory(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    let res = sqlx::query("DELETE FROM factory WHERE id = $1")
        .bind(&id)
        .execute(pool.get_ref())
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("factory {id}")));
    }
    Ok(HttpResponse::NoContent().finish())
}

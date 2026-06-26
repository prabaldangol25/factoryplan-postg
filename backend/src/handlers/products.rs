use actix_web::{delete, get, post, put, web, HttpResponse};

use crate::db::{new_id, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_products)
        .service(create_product)
        .service(update_product)
        .service(delete_product);
}

async fn lead_times_for(pool: &Pool, product_id: &str) -> Result<Vec<LeadTimeRow>, sqlx::Error> {
    sqlx::query_as::<_, LeadTimeRow>(
        "SELECT id, product_id, year, quarter, lead_time_days FROM product_lead_time WHERE product_id = $1 ORDER BY year, quarter",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await
}

async fn factory_lead_times_for(
    pool: &Pool,
    product_id: &str,
) -> Result<Vec<FactoryLeadTimeRow>, sqlx::Error> {
    sqlx::query_as::<_, FactoryLeadTimeRow>(
        "SELECT id, product_id, factory_id, year, quarter, lead_time_days FROM product_factory_lead_time WHERE product_id = $1 ORDER BY factory_id, year, quarter",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await
}

async fn factory_allocations_for(
    pool: &Pool,
    product_id: &str,
) -> Result<Vec<FactoryAllocationRow>, sqlx::Error> {
    sqlx::query_as::<_, FactoryAllocationRow>(
        "SELECT id, product_id, factory_id, year, quarter, allocation_pct FROM product_factory_allocation WHERE product_id = $1 ORDER BY year, quarter, factory_id",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await
}

#[get("/api/scenarios/{id}/products")]
async fn list_products(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let products = sqlx::query_as::<_, ProductRow>(
        "SELECT id, scenario_id, name FROM product WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut out: Vec<Product> = Vec::with_capacity(products.len());
    for p in products {
        let lts = lead_times_for(pool.get_ref(), &p.id).await?;
        let flts = factory_lead_times_for(pool.get_ref(), &p.id).await?;
        let allocs = factory_allocations_for(pool.get_ref(), &p.id).await?;
        out.push(Product {
            id: p.id,
            scenario_id: p.scenario_id,
            name: p.name,
            lead_times: lts,
            factory_lead_times: flts,
            factory_allocations: allocs,
        });
    }
    Ok(HttpResponse::Ok().json(out))
}

fn validate_lead_times(lts: &[LeadTimeInput]) -> Result<(), AppError> {
    for lt in lts {
        if !(1..=4).contains(&lt.quarter) {
            return Err(AppError::BadRequest(format!(
                "quarter must be 1..=4 (got {})",
                lt.quarter
            )));
        }
        if lt.lead_time_days <= 0 {
            return Err(AppError::BadRequest(format!(
                "lead_time_days must be > 0 (got {})",
                lt.lead_time_days
            )));
        }
    }
    Ok(())
}

fn validate_factory_lead_times(lts: &[FactoryLeadTimeInput]) -> Result<(), AppError> {
    for lt in lts {
        if lt.factory_id.trim().is_empty() {
            return Err(AppError::BadRequest(
                "factory_id is required for a factory lead-time override".into(),
            ));
        }
        if !(1..=4).contains(&lt.quarter) {
            return Err(AppError::BadRequest(format!(
                "quarter must be 1..=4 (got {})",
                lt.quarter
            )));
        }
        if lt.lead_time_days <= 0 {
            return Err(AppError::BadRequest(format!(
                "lead_time_days must be > 0 (got {})",
                lt.lead_time_days
            )));
        }
    }
    Ok(())
}

fn validate_factory_allocations(allocs: &[FactoryAllocationInput]) -> Result<(), AppError> {
    let mut seen = std::collections::HashSet::<(i64, i64)>::new();
    for a in allocs {
        if a.factory_id.trim().is_empty() {
            return Err(AppError::BadRequest(
                "factory_id is required for a factory allocation rule".into(),
            ));
        }
        let valid_scope =
            (a.year == 0 && a.quarter == 0) || (a.year > 0 && (1..=4).contains(&a.quarter));
        if !valid_scope {
            return Err(AppError::BadRequest(format!(
                "allocation rule must be global (year=0, quarter=0) or a real quarter (got year={}, quarter={})",
                a.year, a.quarter
            )));
        }
        if !(0..=100).contains(&a.allocation_pct) {
            return Err(AppError::BadRequest(format!(
                "allocation_pct must be 0..=100 (got {})",
                a.allocation_pct
            )));
        }
        if !seen.insert((a.year, a.quarter)) {
            return Err(AppError::BadRequest(format!(
                "only one allocation rule is allowed per product for year={}, quarter={}",
                a.year, a.quarter
            )));
        }
    }
    Ok(())
}

#[post("/api/scenarios/{id}/products")]
async fn create_product(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<CreateProduct>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    validate_lead_times(&body.lead_times)?;
    validate_factory_lead_times(&body.factory_lead_times)?;
    validate_factory_allocations(&body.factory_allocations)?;
    let id = new_id();

    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO product (id, scenario_id, name) VALUES ($1, $2, $3)")
        .bind(&id)
        .bind(&scenario_id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    for lt in &body.lead_times {
        sqlx::query("INSERT INTO product_lead_time (id, product_id, year, quarter, lead_time_days) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&id)
            .bind(lt.year)
            .bind(lt.quarter)
            .bind(lt.lead_time_days)
            .execute(&mut *tx)
            .await?;
    }
    for lt in &body.factory_lead_times {
        sqlx::query("INSERT INTO product_factory_lead_time (id, product_id, factory_id, year, quarter, lead_time_days) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(new_id())
            .bind(&id)
            .bind(&lt.factory_id)
            .bind(lt.year)
            .bind(lt.quarter)
            .bind(lt.lead_time_days)
            .execute(&mut *tx)
            .await?;
    }
    for a in &body.factory_allocations {
        sqlx::query("INSERT INTO product_factory_allocation (id, product_id, factory_id, year, quarter, allocation_pct) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(new_id())
            .bind(&id)
            .bind(&a.factory_id)
            .bind(a.year)
            .bind(a.quarter)
            .bind(a.allocation_pct)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let p =
        sqlx::query_as::<_, ProductRow>("SELECT id, scenario_id, name FROM product WHERE id = $1")
            .bind(&id)
            .fetch_one(pool.get_ref())
            .await?;
    let lts = lead_times_for(pool.get_ref(), &p.id).await?;
    let flts = factory_lead_times_for(pool.get_ref(), &p.id).await?;
    let allocs = factory_allocations_for(pool.get_ref(), &p.id).await?;
    Ok(HttpResponse::Created().json(Product {
        id: p.id,
        scenario_id: p.scenario_id,
        name: p.name,
        lead_times: lts,
        factory_lead_times: flts,
        factory_allocations: allocs,
    }))
}

#[put("/api/products/{id}")]
async fn update_product(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    body: web::Json<UpdateProduct>,
) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    validate_lead_times(&body.lead_times)?;
    validate_factory_lead_times(&body.factory_lead_times)?;
    validate_factory_allocations(&body.factory_allocations)?;

    let mut tx = pool.begin().await?;
    let res = sqlx::query("UPDATE product SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("product {id}")));
    }

    // Replace lead-time matrix wholesale
    sqlx::query("DELETE FROM product_lead_time WHERE product_id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for lt in &body.lead_times {
        sqlx::query("INSERT INTO product_lead_time (id, product_id, year, quarter, lead_time_days) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&id)
            .bind(lt.year)
            .bind(lt.quarter)
            .bind(lt.lead_time_days)
            .execute(&mut *tx)
            .await?;
    }

    // Replace per-factory lead-time overrides wholesale
    sqlx::query("DELETE FROM product_factory_lead_time WHERE product_id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for lt in &body.factory_lead_times {
        sqlx::query("INSERT INTO product_factory_lead_time (id, product_id, factory_id, year, quarter, lead_time_days) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(new_id())
            .bind(&id)
            .bind(&lt.factory_id)
            .bind(lt.year)
            .bind(lt.quarter)
            .bind(lt.lead_time_days)
            .execute(&mut *tx)
            .await?;
    }

    // Replace product-factory allocation rules wholesale
    sqlx::query("DELETE FROM product_factory_allocation WHERE product_id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for a in &body.factory_allocations {
        sqlx::query("INSERT INTO product_factory_allocation (id, product_id, factory_id, year, quarter, allocation_pct) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(new_id())
            .bind(&id)
            .bind(&a.factory_id)
            .bind(a.year)
            .bind(a.quarter)
            .bind(a.allocation_pct)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let p =
        sqlx::query_as::<_, ProductRow>("SELECT id, scenario_id, name FROM product WHERE id = $1")
            .bind(&id)
            .fetch_one(pool.get_ref())
            .await?;
    let lts = lead_times_for(pool.get_ref(), &p.id).await?;
    let flts = factory_lead_times_for(pool.get_ref(), &p.id).await?;
    let allocs = factory_allocations_for(pool.get_ref(), &p.id).await?;
    Ok(HttpResponse::Ok().json(Product {
        id: p.id,
        scenario_id: p.scenario_id,
        name: p.name,
        lead_times: lts,
        factory_lead_times: flts,
        factory_allocations: allocs,
    }))
}

#[delete("/api/products/{id}")]
async fn delete_product(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let id = path.into_inner();
    let res = sqlx::query("DELETE FROM product WHERE id = $1")
        .bind(&id)
        .execute(pool.get_ref())
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("product {id}")));
    }
    Ok(HttpResponse::NoContent().finish())
}

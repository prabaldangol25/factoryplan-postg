mod db;
mod error;
mod handlers;
mod models;
mod recommendations;
mod scheduling;

use actix_cors::Cors;
use actix_web::{get, web, App, HttpServer, Responder};
use serde::Serialize;

use crate::db::Pool;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[get("/api/health")]
async fn health() -> impl Responder {
    web::Json(Health {
        status: "ok",
        service: "factoryplan-backend",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgresql://postgres:postgres@localhost:5432/factoryplan".to_string()
    });

    log::info!("factoryplan-backend starting on {host}:{port}  (db={database_url})");

    let pool: Pool = db::init_pool(&database_url)
        .await
        .expect("failed to initialize database pool");

    // Clear any agent prompt files left behind by a prior crash.
    handlers::agent::cleanup_temp_files();

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::JsonConfig::default().limit(100 * 1024 * 1024))
            .wrap(cors)
            .service(health)
            .configure(handlers::configure)
    })
    .bind((host.as_str(), port))?
    .run()
    .await
}

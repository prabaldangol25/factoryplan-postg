use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub type Pool = PgPool;

fn pool_size(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub async fn init_pool(database_url: &str) -> Result<Pool, sqlx::Error> {
    let max_connections = pool_size("DB_POOL_MAX_CONNECTIONS", 3);
    let min_connections = pool_size("DB_POOL_MIN_CONNECTIONS", 1).min(max_connections);
    log::info!(
        "database pool configured with {min_connections} minimum and {max_connections} maximum connections"
    );

    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(min_connections)
        .test_before_acquire(true)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

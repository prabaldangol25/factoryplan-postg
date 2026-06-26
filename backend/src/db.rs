use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub type Pool = PgPool;

pub async fn init_pool(database_url: &str) -> Result<Pool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .min_connections(1)
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

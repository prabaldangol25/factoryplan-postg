mod db;
mod error;
mod handlers;
mod models;
mod recommendations;
mod scheduling;

use actix_cors::Cors;
use actix_web::{
    body::{EitherBody, MessageBody},
    dev::{ServiceRequest, ServiceResponse},
    get,
    http::Method,
    middleware::{from_fn, Next},
    post, web, App, HttpRequest, HttpResponse, HttpServer, Responder,
};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

#[derive(Deserialize)]
struct LoginRequest {
    password: String,
}

#[derive(Serialize)]
struct AuthStatus {
    enabled: bool,
    authenticated: bool,
    token: Option<String>,
}

fn configured_password() -> Option<String> {
    std::env::var("APP_PASSWORD")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

fn cors_config() -> Cors {
    let cors = Cors::default()
        .allow_any_method()
        .allow_any_header()
        .max_age(3600);
    let origins = std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    if origins.is_empty() {
        return cors.allow_any_origin();
    }

    origins
        .iter()
        .fold(cors, |cors, origin| cors.allowed_origin(origin))
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn session_ttl() -> Duration {
    let hours = std::env::var("APP_SESSION_TTL_HOURS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|hours| *hours > 0)
        .unwrap_or(12);
    Duration::from_secs(hours * 60 * 60)
}

fn issue_session() -> String {
    let token = Uuid::new_v4().to_string();
    let expires_at = Instant::now() + session_ttl();
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("session lock poisoned");
    sessions.retain(|_, expiry| *expiry > Instant::now());
    sessions.insert(token.clone(), expires_at);
    token
}

fn request_token(req: &HttpRequest) -> Option<&str> {
    req.headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn request_is_authenticated(req: &HttpRequest) -> bool {
    if configured_password().is_none() {
        return true;
    }
    let Some(token) = request_token(req) else {
        return false;
    };
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("session lock poisoned");
    let now = Instant::now();
    sessions.retain(|_, expiry| *expiry > now);
    sessions.get(token).is_some_and(|expiry| *expiry > now)
}

#[post("/api/auth/login")]
async fn login(body: web::Json<LoginRequest>) -> HttpResponse {
    let Some(password) = configured_password() else {
        return HttpResponse::Ok().json(AuthStatus {
            enabled: false,
            authenticated: true,
            token: None,
        });
    };

    if body.password == password {
        HttpResponse::Ok().json(AuthStatus {
            enabled: true,
            authenticated: true,
            token: Some(issue_session()),
        })
    } else {
        HttpResponse::Unauthorized().json(AuthStatus {
            enabled: true,
            authenticated: false,
            token: None,
        })
    }
}

#[get("/api/auth/check")]
async fn auth_check(req: HttpRequest) -> HttpResponse {
    let enabled = configured_password().is_some();
    HttpResponse::Ok().json(AuthStatus {
        enabled,
        authenticated: request_is_authenticated(&req),
        token: None,
    })
}

async fn auth_gate(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<EitherBody<impl MessageBody>>, actix_web::Error> {
    let path = req.path();
    let public = req.method() == Method::OPTIONS
        || path == "/api/health"
        || path == "/api/auth/login"
        || path == "/api/auth/check"
        || !path.starts_with("/api/");

    if public || request_is_authenticated(req.request()) {
        return next
            .call(req)
            .await
            .map(ServiceResponse::map_into_left_body);
    }

    Ok(req.into_response(
        HttpResponse::Unauthorized()
            .json(AuthStatus {
                enabled: true,
                authenticated: false,
                token: None,
            })
            .map_into_right_body(),
    ))
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

    if !is_local_host(&host) && configured_password().is_none() {
        panic!("APP_PASSWORD must be set when binding to a non-local host");
    }

    log::info!("factoryplan-backend starting on {host}:{port}");

    let pool: Pool = db::init_pool(&database_url)
        .await
        .expect("failed to initialize database pool");

    // Clear any agent prompt files left behind by a prior crash.
    handlers::agent::cleanup_temp_files();

    HttpServer::new(move || {
        let cors = cors_config();

        App::new()
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::JsonConfig::default().limit(100 * 1024 * 1024))
            .wrap(from_fn(auth_gate))
            .wrap(cors)
            .service(health)
            .service(login)
            .service(auth_check)
            .configure(handlers::configure)
    })
    .bind((host.as_str(), port))?
    .run()
    .await
}

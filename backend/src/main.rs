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
use serde::{Deserialize, Serialize};

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

fn token_for_password(password: &str) -> String {
    let mut out = String::with_capacity(password.len() * 2);
    for b in password.as_bytes() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn request_token(req: &HttpRequest) -> Option<String> {
    if let Some(header) = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = header.strip_prefix("Bearer ") {
            return Some(token.trim().to_string());
        }
    }

    req.query_string().split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == "auth_token" && !value.is_empty()).then(|| value.to_string())
    })
}

fn request_is_authenticated(req: &HttpRequest) -> bool {
    let Some(password) = configured_password() else {
        return true;
    };
    request_token(req).as_deref() == Some(token_for_password(&password).as_str())
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
            token: Some(token_for_password(&password)),
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

pub mod agent;
pub mod demand;
pub mod factories;
pub mod import_export;
pub mod orders;
pub mod products;
pub mod runs;
pub mod scenarios;

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    scenarios::configure(cfg);
    factories::configure(cfg);
    orders::configure(cfg);
    products::configure(cfg);
    demand::configure(cfg);
    runs::configure(cfg);
    import_export::configure(cfg);
    agent::configure(cfg);
}

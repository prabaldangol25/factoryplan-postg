use serde::{Deserialize, Serialize};

// ---------- Scenario ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Scenario {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateScenario {
    pub name: String,
    /// Optional id of a scenario to clone (factories/products/lead-times/demand)
    pub clone_from: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateScenario {
    pub name: String,
}

// ---------- Factory ----------

/// Raw `factory` row (used internally and during scenario cloning).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Factory {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub bays: i64,
    pub changeover_days: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct BayCountRow {
    pub id: String,
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub bays: i64,
}

/// Composite Factory returned to API clients — base bays + per-quarter overrides.
#[derive(Debug, Clone, Serialize)]
pub struct FactoryWithBayCounts {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub bays: i64,
    pub changeover_days: i64,
    pub bay_counts: Vec<BayCountRow>,
}

#[derive(Debug, Deserialize)]
pub struct BayCountInput {
    pub year: i64,
    pub quarter: i64,
    pub bays: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateFactory {
    pub name: String,
    pub bays: i64,
    #[serde(default)]
    pub changeover_days: i64,
    #[serde(default)]
    pub bay_counts: Vec<BayCountInput>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateFactory {
    pub name: String,
    pub bays: i64,
    #[serde(default)]
    pub changeover_days: i64,
    #[serde(default)]
    pub bay_counts: Vec<BayCountInput>,
}

// ---------- Product + lead times ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ProductRow {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct LeadTimeRow {
    pub id: String,
    pub product_id: String,
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

/// Per-(product, factory, year, quarter) lead-time override. Falls back to the
/// product's base lead time (`LeadTimeRow`) when no override is defined.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FactoryLeadTimeRow {
    pub id: String,
    pub product_id: String,
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FactoryAllocationRow {
    pub id: String,
    pub product_id: String,
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub allocation_pct: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Product {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub lead_times: Vec<LeadTimeRow>,
    /// Optional per-factory overrides. Empty means "same lead time everywhere".
    pub factory_lead_times: Vec<FactoryLeadTimeRow>,
    /// Optional target-factory allocation rules. year=0/quarter=0 means global.
    pub factory_allocations: Vec<FactoryAllocationRow>,
}

#[derive(Debug, Deserialize)]
pub struct LeadTimeInput {
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

#[derive(Debug, Deserialize)]
pub struct FactoryLeadTimeInput {
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

#[derive(Debug, Deserialize)]
pub struct FactoryAllocationInput {
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub allocation_pct: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateProduct {
    pub name: String,
    #[serde(default)]
    pub lead_times: Vec<LeadTimeInput>,
    #[serde(default)]
    pub factory_lead_times: Vec<FactoryLeadTimeInput>,
    #[serde(default)]
    pub factory_allocations: Vec<FactoryAllocationInput>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProduct {
    pub name: String,
    /// Full replacement of lead-time matrix
    #[serde(default)]
    pub lead_times: Vec<LeadTimeInput>,
    /// Full replacement of per-factory lead-time overrides
    #[serde(default)]
    pub factory_lead_times: Vec<FactoryLeadTimeInput>,
    /// Full replacement of target-factory allocation rules
    #[serde(default)]
    pub factory_allocations: Vec<FactoryAllocationInput>,
}

// ---------- Demand ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Demand {
    pub id: String,
    pub scenario_id: String,
    pub product_id: String,
    pub period_type: String, // 'month' | 'quarter'
    pub year: i64,
    pub period_index: i64,
    pub quantity: i64,
    pub spread_mode: String, // 'even' | 'start' | 'end'
    pub serial_mode: String, // 'none' | 'sequence' | 'list'
    pub serial_start: Option<String>,
    pub serial_list: Option<String>, // newline-separated when serial_mode = 'list'
}

#[derive(Debug, Deserialize)]
pub struct CreateDemand {
    pub product_id: String,
    pub period_type: String,
    pub year: i64,
    pub period_index: i64,
    pub quantity: i64,
    #[serde(default = "default_spread")]
    pub spread_mode: String,
    #[serde(default = "default_serial_mode")]
    pub serial_mode: String,
    #[serde(default)]
    pub serial_start: Option<String>,
    #[serde(default)]
    pub serial_list: Option<String>,
}

fn default_spread() -> String {
    "even".to_string()
}

fn default_serial_mode() -> String {
    "none".to_string()
}

#[derive(Debug, Deserialize)]
pub struct UpdateDemand {
    pub product_id: String,
    pub period_type: String,
    pub year: i64,
    pub period_index: i64,
    pub quantity: i64,
    pub spread_mode: String,
    #[serde(default = "default_serial_mode")]
    pub serial_mode: String,
    #[serde(default)]
    pub serial_start: Option<String>,
    #[serde(default)]
    pub serial_list: Option<String>,
}

// ---------- Schedule run / units / recommendations (used by Phase 2+) ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ScheduleRun {
    pub id: String,
    pub scenario_id: String,
    pub run_at: String,
    pub total_demand: i64,
    pub shipped_on_time: i64,
    pub shipped_late: i64,
    pub unshippable: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ScheduledUnit {
    pub id: String,
    pub run_id: String,
    pub demand_id: String,
    pub product_id: String,
    pub factory_id: Option<String>,
    pub bay_index: Option<i64>,
    pub required_start: String,
    pub due_date: String,
    pub status: String,
    pub serial: Option<String>,
    pub orig_due_date: Option<String>,
    pub is_late: bool,
}

/// Per-quarter count of units that missed that quarter and rolled forward.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct QuarterMissRow {
    pub id: String,
    pub run_id: String,
    pub year: i64,
    pub quarter: i64,
    pub missed_count: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RecommendationRow {
    pub id: String,
    pub run_id: String,
    pub rec_type: String,
    pub payload_json: String,
}

// ---------- Agent (Devin-powered scheduling chat) ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AgentConversation {
    pub id: String,
    pub scenario_id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AgentMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String, // 'user' | 'assistant' | 'system'
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AgentChatRequest {
    pub scenario_id: String,
    pub message: String,
    /// None = start a new conversation.
    pub conversation_id: Option<String>,
}

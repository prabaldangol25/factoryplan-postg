use actix_web::web::Bytes;
use actix_web::{delete, get, post, web, HttpResponse};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::db::{new_id, now_iso, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(agent_chat)
        .service(list_conversations)
        .service(get_messages)
        .service(delete_conversation);
}

/// Hard cap on how long a single devin turn may run before we kill it.
const DEVIN_TIMEOUT_SECS: u64 = 180;

fn devin_cmd() -> String {
    std::env::var("DEVIN_CMD").unwrap_or_else(|_| "devin".to_string())
}

/// Remove any stale prompt files left behind by a prior crash. Best-effort.
pub fn cleanup_temp_files() {
    let dir = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("factoryplan_agent_input_") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

fn api_base() -> String {
    // Where devin should point its curl/HTTP calls. Defaults to the local server.
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    // 0.0.0.0 is a bind address, not a connect address.
    let host = if host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        host
    };
    format!("http://{host}:{port}")
}

// ---------------------------------------------------------------------------
// POST /api/agent/chat  — SSE stream
// ---------------------------------------------------------------------------

#[post("/api/agent/chat")]
async fn agent_chat(
    pool: web::Data<Pool>,
    body: web::Json<AgentChatRequest>,
) -> AppResult<HttpResponse> {
    let scenario_id = body.scenario_id.clone();
    let user_msg = body.message.trim().to_string();
    if user_msg.is_empty() {
        return Err(AppError::BadRequest("message must not be empty".into()));
    }

    // Verify scenario exists.
    let scenario = sqlx::query_as::<_, Scenario>(
        "SELECT id, name, created_at, updated_at, is_active FROM scenario WHERE id = $1",
    )
    .bind(&scenario_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("scenario {scenario_id}")))?;

    // Get or create the conversation.
    let (conv_id, is_new_conv) = match &body.conversation_id {
        Some(id) => {
            let found: Option<(String,)> =
                sqlx::query_as("SELECT id FROM agent_conversation WHERE id = $1")
                    .bind(id)
                    .fetch_optional(pool.get_ref())
                    .await?;
            if found.is_none() {
                return Err(AppError::NotFound(format!("conversation {id}")));
            }
            (id.clone(), false)
        }
        None => {
            let id = new_id();
            let now = now_iso();
            let title = truncate_title(&user_msg);
            sqlx::query("INSERT INTO agent_conversation (id, scenario_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)")
                .bind(&id)
                .bind(&scenario_id)
                .bind(&title)
                .bind(&now)
                .bind(&now)
                .execute(pool.get_ref())
                .await?;
            (id, true)
        }
    };

    // Load prior history BEFORE inserting the new user message.
    let history = sqlx::query_as::<_, AgentMessage>(
        "SELECT id, conversation_id, role, content, created_at FROM agent_message WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(&conv_id)
    .fetch_all(pool.get_ref())
    .await?;

    // Persist the user message.
    let now = now_iso();
    sqlx::query("INSERT INTO agent_message (id, conversation_id, role, content, created_at) VALUES ($1, $2, 'user', $3, $4)")
        .bind(new_id())
        .bind(&conv_id)
        .bind(&user_msg)
        .bind(&now)
        .execute(pool.get_ref())
        .await?;
    sqlx::query("UPDATE agent_conversation SET updated_at = $1 WHERE id = $2")
        .bind(&now)
        .bind(&conv_id)
        .execute(pool.get_ref())
        .await?;

    // Build the prompt (first message gets the full Tier-2 detail block).
    let system_prompt = build_system_prompt(pool.get_ref(), &scenario, history.is_empty()).await?;
    let devin_input = format_devin_input(&system_prompt, &history, &user_msg);

    // Write the prompt to a temp file (Windows-safe temp dir).
    let input_path = std::env::temp_dir().join(format!("factoryplan_agent_input_{conv_id}.txt"));
    std::fs::write(&input_path, &devin_input)
        .map_err(|e| AppError::Internal(format!("write prompt file: {e}")))?;

    let _ = is_new_conv; // conv id is announced in the stream regardless
    let stream = spawn_devin_stream(pool.get_ref().clone(), conv_id.clone(), input_path);

    Ok(HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(stream))
}

/// Spawn devin in print mode and stream its stdout back as SSE events.
///
/// Event protocol (one logical event per `data:` line):
///   data: [CONV] <conversation_id>     — sent once, first, so the client can pin a new conv
///   data: <line of the assistant response>
///   data: [ERROR] <message>            — fatal error; stream ends after this
///   data: [DONE]                       — normal completion
fn spawn_devin_stream(
    pool: Pool,
    conv_id: String,
    input_path: std::path::PathBuf,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);

    tokio::spawn(async move {
        // Announce the conversation id up front (important for new conversations).
        let _ = tx.send(Ok(sse(&format!("[CONV] {conv_id}")))).await;

        let input_arg = input_path.to_string_lossy().to_string();
        let spawn_result = tokio::process::Command::new(devin_cmd())
            .arg("-p")
            .arg("--prompt-file")
            .arg(&input_arg)
            .arg("--permission-mode")
            .arg("dangerous")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();

        let mut child = match spawn_result {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(Ok(sse(&format!(
                        "[ERROR] Could not start the agent ({}). Is the `devin` CLI installed and on PATH?",
                        e
                    ))))
                    .await;
                let _ = tx.send(Ok(sse("[DONE]"))).await;
                let _ = tokio::fs::remove_file(&input_path).await;
                return;
            }
        };

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let mut out_lines = BufReader::new(stdout).lines();

        // Drain stderr in the background so the child never blocks on a full pipe.
        let stderr_handle = tokio::spawn(async move {
            let mut buf = String::new();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        });

        let deadline =
            tokio::time::Instant::now() + tokio::time::Duration::from_secs(DEVIN_TIMEOUT_SECS);
        let mut response = String::new();
        let mut timed_out = false;

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                timed_out = true;
                break;
            }
            match tokio::time::timeout(remaining, out_lines.next_line()).await {
                Ok(Ok(Some(line))) => {
                    if !response.is_empty() {
                        response.push('\n');
                    }
                    response.push_str(&line);
                    if tx.send(Ok(sse(&line))).await.is_err() {
                        // Client disconnected — kill devin and stop.
                        let _ = child.start_kill();
                        let _ = tokio::fs::remove_file(&input_path).await;
                        return;
                    }
                }
                Ok(Ok(None)) => break, // EOF
                Ok(Err(e)) => {
                    let _ = tx.send(Ok(sse(&format!("[ERROR] read failed: {e}")))).await;
                    break;
                }
                Err(_) => {
                    timed_out = true;
                    break;
                }
            }
        }

        if timed_out {
            let _ = child.start_kill();
            let _ = tx
                .send(Ok(sse(
                    "[ERROR] Agent timed out. Try a more specific question.",
                )))
                .await;
        }

        // Reap the process (best effort) and grab stderr.
        let status = tokio::time::timeout(tokio::time::Duration::from_secs(5), child.wait())
            .await
            .ok()
            .and_then(|r| r.ok());
        let stderr_text = stderr_handle.await.unwrap_or_default();

        let trimmed = response.trim();
        if trimmed.is_empty() && !timed_out {
            // Surface a useful diagnostic instead of an empty bubble.
            let detail = if !stderr_text.trim().is_empty() {
                format!("[ERROR] Agent produced no response. {}", stderr_text.trim())
            } else if matches!(status, Some(s) if !s.success()) {
                "[ERROR] Agent exited without producing a response.".to_string()
            } else {
                "[ERROR] Agent produced no response.".to_string()
            };
            let _ = tx.send(Ok(sse(&detail))).await;
        }

        // Persist the assistant message (only if we actually got content).
        if !trimmed.is_empty() {
            let now = now_iso();
            let _ = sqlx::query("INSERT INTO agent_message (id, conversation_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3, $4)")
                .bind(new_id())
                .bind(&conv_id)
                .bind(trimmed)
                .bind(&now)
                .execute(&pool)
                .await;
            let _ = sqlx::query("UPDATE agent_conversation SET updated_at = $1 WHERE id = $2")
                .bind(&now)
                .bind(&conv_id)
                .execute(&pool)
                .await;
        }

        let _ = tokio::fs::remove_file(&input_path).await;
        let _ = tx.send(Ok(sse("[DONE]"))).await;
    });

    tokio_stream::wrappers::ReceiverStream::new(rx)
}

/// Build a single SSE `data:` event from one line of text.
fn sse(line: &str) -> Bytes {
    Bytes::from(format!("data: {line}\n\n"))
}

// ---------------------------------------------------------------------------
// Conversation management endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ScenarioIdQuery {
    scenario_id: String,
}

#[get("/api/agent/conversations")]
async fn list_conversations(
    pool: web::Data<Pool>,
    query: web::Query<ScenarioIdQuery>,
) -> AppResult<HttpResponse> {
    let convs = sqlx::query_as::<_, AgentConversation>(
        "SELECT id, scenario_id, title, created_at, updated_at FROM agent_conversation WHERE scenario_id = $1 ORDER BY updated_at DESC",
    )
    .bind(&query.scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(convs))
}

#[get("/api/agent/conversations/{id}/messages")]
async fn get_messages(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let conv_id = path.into_inner();
    let msgs = sqlx::query_as::<_, AgentMessage>(
        "SELECT id, conversation_id, role, content, created_at FROM agent_message WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(&conv_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(msgs))
}

#[delete("/api/agent/conversations/{id}")]
async fn delete_conversation(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse> {
    let conv_id = path.into_inner();
    sqlx::query("DELETE FROM agent_conversation WHERE id = $1")
        .bind(&conv_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

fn truncate_title(msg: &str) -> String {
    let one_line = msg.replace(['\n', '\r'], " ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= 60 {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(57).collect();
        s.push_str("...");
        s
    }
}

fn format_devin_input(system_prompt: &str, history: &[AgentMessage], user_msg: &str) -> String {
    let mut s = String::new();
    s.push_str(system_prompt);
    if !history.is_empty() {
        s.push_str("\n\n## Conversation so far\n\n");
        for m in history {
            let who = match m.role.as_str() {
                "user" => "User",
                "assistant" => "You (assistant)",
                _ => "System",
            };
            s.push_str(&format!("### {who}\n{}\n\n", m.content));
        }
    }
    s.push_str("\n\n## Current user message\n\n");
    s.push_str(user_msg);
    s.push_str("\n\nAnswer this message now, following the instructions above.\n");
    s
}

async fn build_system_prompt(
    pool: &Pool,
    scenario: &Scenario,
    include_details: bool,
) -> AppResult<String> {
    let mut p = String::new();
    p.push_str(DOMAIN_EXPERTISE);
    p.push_str(&api_reference());
    p.push_str(&format_scenario_context(pool, scenario, include_details).await?);
    p.push_str(&response_instructions());
    Ok(p)
}

/// Tier 1 (always) + optionally Tier 2 (first message) scenario context.
async fn format_scenario_context(
    pool: &Pool,
    scenario: &Scenario,
    include_details: bool,
) -> AppResult<String> {
    let scenario_id = &scenario.id;

    // Counts for Tier 1.
    let (factory_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM factory WHERE scenario_id = $1")
            .bind(scenario_id)
            .fetch_one(pool)
            .await?;
    let (product_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM product WHERE scenario_id = $1")
            .bind(scenario_id)
            .fetch_one(pool)
            .await?;
    let (total_bays,): (Option<i64>,) =
        sqlx::query_as("SELECT COALESCE(SUM(bays), 0)::BIGINT FROM factory WHERE scenario_id = $1")
            .bind(scenario_id)
            .fetch_one(pool)
            .await?;
    let (demand_rows,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM demand WHERE scenario_id = $1")
            .bind(scenario_id)
            .fetch_one(pool)
            .await?;
    let (demand_units,): (Option<i64>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(quantity), 0)::BIGINT FROM demand WHERE scenario_id = $1",
    )
    .bind(scenario_id)
    .fetch_one(pool)
    .await?;

    let latest_run = sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable FROM schedule_run WHERE scenario_id = $1 ORDER BY run_at DESC LIMIT 1",
    )
    .bind(scenario_id)
    .fetch_optional(pool)
    .await?;

    let mut s = String::new();
    s.push_str("\n## Current scenario\n\n");
    s.push_str(&format!(
        "- Scenario: \"{}\" (id: {})\n",
        scenario.name, scenario.id
    ));
    s.push_str(&format!(
        "- Factories: {} (total {} base bays)\n",
        factory_count,
        total_bays.unwrap_or(0)
    ));
    s.push_str(&format!("- Products: {product_count}\n"));
    s.push_str(&format!(
        "- Demand: {} rows, {} units total\n",
        demand_rows,
        demand_units.unwrap_or(0)
    ));
    match &latest_run {
        Some(r) => {
            let fill = if r.total_demand > 0 {
                (r.shipped_on_time as f64 / r.total_demand as f64) * 100.0
            } else {
                0.0
            };
            s.push_str(&format!(
                "- Last run: {} total, {} shipped on time, {} unshippable ({:.0}% fill)\n",
                r.total_demand, r.shipped_on_time, r.unshippable, fill
            ));
        }
        None => s.push_str("- Last run: none yet (no schedule has been computed)\n"),
    }

    if include_details {
        s.push_str(&format_scenario_details(pool, scenario_id).await?);
    }

    Ok(s)
}

/// Tier 2: per-factory bay matrix, per-product lead times, demand by period.
async fn format_scenario_details(pool: &Pool, scenario_id: &str) -> AppResult<String> {
    let mut s = String::new();

    // Factories + per-quarter overrides.
    let factories = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    if !factories.is_empty() {
        s.push_str("\n### Factories\n");
        for f in &factories {
            let bcs = sqlx::query_as::<_, BayCountRow>(
                "SELECT id, factory_id, year, quarter, bays FROM factory_bay_count WHERE factory_id = $1 ORDER BY year, quarter",
            )
            .bind(&f.id)
            .fetch_all(pool)
            .await?;
            let overrides = if bcs.is_empty() {
                String::new()
            } else {
                let parts: Vec<String> = bcs
                    .iter()
                    .map(|b| format!("{} Q{}: {} bays", b.year, b.quarter, b.bays))
                    .collect();
                format!(", {}", parts.join(", "))
            };
            s.push_str(&format!(
                "- {}: {} bays (base), {} changeover days{}\n",
                f.name, f.bays, f.changeover_days, overrides
            ));
        }
    }

    // Products + lead times.
    let products = sqlx::query_as::<_, ProductRow>(
        "SELECT id, scenario_id, name FROM product WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    if !products.is_empty() {
        s.push_str("\n### Products (lead time = days a unit occupies a bay)\n");
        for p in &products {
            let lts = sqlx::query_as::<_, LeadTimeRow>(
                "SELECT id, product_id, year, quarter, lead_time_days FROM product_lead_time WHERE product_id = $1 ORDER BY year, quarter",
            )
            .bind(&p.id)
            .fetch_all(pool)
            .await?;
            if lts.is_empty() {
                s.push_str(&format!("- {}: (no lead times set)\n", p.name));
            } else {
                let parts: Vec<String> = lts
                    .iter()
                    .map(|l| format!("{} Q{}: {}d", l.year, l.quarter, l.lead_time_days))
                    .collect();
                s.push_str(&format!("- {}: {}\n", p.name, parts.join(", ")));
            }
        }
    }

    // Demand by period.
    let demand = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1 ORDER BY year, period_index",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    if !demand.is_empty() {
        // Map product id -> name for readability.
        let mut name_of = std::collections::HashMap::new();
        for p in &products {
            name_of.insert(p.id.clone(), p.name.clone());
        }
        s.push_str("\n### Demand\n");
        for d in &demand {
            let pname = name_of
                .get(&d.product_id)
                .cloned()
                .unwrap_or_else(|| d.product_id.clone());
            let period = if d.period_type == "quarter" {
                format!("{} Q{}", d.year, d.period_index)
            } else {
                format!("{} M{}", d.year, d.period_index)
            };
            s.push_str(&format!(
                "- {}: {} {} units ({} spread)\n",
                period, d.quantity, pname, d.spread_mode
            ));
        }
    }

    Ok(s)
}

// ---------------------------------------------------------------------------
// Static prompt sections
// ---------------------------------------------------------------------------

const DOMAIN_EXPERTISE: &str = r#"You are a finite-capacity production-scheduling expert embedded in "factoryplan",
a backward-scheduling planner. You answer the user's question concisely and quantitatively.

Key concepts you understand deeply:
- Lead time (a.k.a. cycle time): the number of days a unit occupies a bay from build
  start to ship. It is defined per (product, quarter).
- Bays: physical build positions in a factory. One bay holds one unit at a time. Bay
  count can vary per quarter (seasonal ramp up/down) via per-quarter overrides.
- Backward scheduling: each unit is scheduled backward from its due date. Its required
  window is [due_date - lead_time + 1, due_date]. Units are placed earliest-required-start
  first, into the least-loaded free bay across ALL factories (global, load-balanced greedy).
- Demand explosion: aggregate demand (e.g. "20 units in Q3") is exploded into individual
  units whose due dates are spread across the period (even / start / end).
- Unshippable: if no bay is free for a unit's required window, that unit is unshippable.
- Cross-quarter windows: when a build window spans two quarters, the effective bay count
  is the MINIMUM of the two quarters (you can't use bays that don't exist in one quarter).
  The lead time used is the one for the quarter the DUE DATE falls in.

Think in manufacturing terms. Reference specific factories, products, quarters, bay
counts, lead times, quantities, dates, and percentages.
"#;

fn api_reference() -> String {
    let base = api_base();
    format!(
        r#"
## factoryplan API ({base})

You have an `exec` tool. Use `curl` to call the API when you need data beyond the
snapshot below (per-unit assignments, exact bay matrices, or to run what-if experiments).
All responses are JSON. On Windows use `curl.exe`.

Read:
  GET  {base}/api/scenarios
  GET  {base}/api/scenarios/{{id}}
  GET  {base}/api/scenarios/{{id}}/factories     (factories + per-quarter bay_counts)
  GET  {base}/api/scenarios/{{id}}/products       (products + per-quarter lead_times)
  GET  {base}/api/scenarios/{{id}}/demand
  GET  {base}/api/runs/{{run_id}}                 (results + recommendations)

Write (use only if the user asks you to change data or run a what-if):
  POST {base}/api/scenarios                       {{ "name", "clone_from"? }}
  POST {base}/api/scenarios/{{id}}/factories       {{ "name", "bays", "bay_counts": [...] }}
  PUT  {base}/api/factories/{{id}}                 {{ "name", "bays", "bay_counts": [...] }}
  POST {base}/api/scenarios/{{id}}/products         {{ "name", "lead_times": [...] }}
  PUT  {base}/api/products/{{id}}                   {{ "name", "lead_times": [...] }}
  POST {base}/api/scenarios/{{id}}/demand
  POST {base}/api/scenarios/{{id}}/run             (runs the scheduler; returns full results)

Run results include:
  run: {{ total_demand, shipped_on_time, unshippable }}
  units: [ {{ product_id, factory_id, bay_index, required_start, due_date, status }} ]
  recommendation: {{ bays_needed, uniform_lt_pct, per_product_lt }}

For what-if experiments, clone the scenario first (POST /api/scenarios with clone_from),
modify the clone, run it, and compare against the current scenario. NEVER mutate the
user's active scenario unless they explicitly ask you to.
"#
    )
}

fn response_instructions() -> String {
    r#"
## How to respond

1. Answer the user's question directly. Lead with the conclusion, then the reasoning.
2. Pull extra data via curl when needed, but do NOT dump raw JSON into your answer —
   interpret it (cite factory/product names, numbers, dates, percentages).
3. For what-if requests, clone + modify + run, then summarize what changed and the result.
4. Use clean Markdown: short paragraphs, bullet lists, tables, **bold** for key numbers.
5. Be concise. Do not narrate your tool calls or thinking — only output the final answer.
6. Print ONLY your final answer to stdout. Nothing else.
"#
    .to_string()
}

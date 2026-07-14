use actix_web::{get, post, web, HttpResponse};
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::db::{new_id, now_iso, Pool};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::recommendations::{compute_recommendations, RecommendationOut};
use crate::scheduling::{
    generate_serials, run_schedule_mode, run_schedule_with_lt_mode, BayAssignment, BayCountInput,
    BayWeekInput, DemandInput, FactoryAllocationInput, FactoryInput, FactoryLeadTimeInput,
    LeadTimeInput, ProductInput, ScheduleInput, ScheduleOutput, UnitStatus,
};

/// Query params for a run. `optimize=utilization` packs work to maximize bay
/// utilization (leaving unneeded bays empty); anything else load-balances.
#[derive(Debug, Deserialize)]
struct RunQuery {
    #[serde(default)]
    optimize: Option<String>,
    #[serde(default)]
    max_starts_per_week: Option<i64>,
    #[serde(default)]
    factory_starts_per_week: Option<String>,
    #[serde(default)]
    lead_time_pct: Option<f64>,
    #[serde(default)]
    factory_lead_time_pct: Option<String>,
    #[serde(default)]
    lead_time_days: Option<i64>,
    #[serde(default)]
    factory_lead_time_days: Option<String>,
}

impl RunQuery {
    fn assignment(&self) -> BayAssignment {
        match self.optimize.as_deref() {
            Some("utilization") => BayAssignment::MaximizeUtilization,
            _ => BayAssignment::BalanceLoad,
        }
    }

    fn factory_start_limits(&self) -> HashMap<String, i64> {
        parse_factory_start_limits(self.factory_starts_per_week.as_deref())
    }

    fn factory_lead_time_limits(&self) -> HashMap<String, f64> {
        parse_factory_percent_limits(self.factory_lead_time_pct.as_deref())
    }

    fn factory_lead_time_day_limits(&self) -> HashMap<String, i64> {
        parse_factory_day_limits(self.factory_lead_time_days.as_deref())
    }
}

fn parse_factory_start_limits(raw: Option<&str>) -> HashMap<String, i64> {
    raw.unwrap_or("")
        .split(',')
        .filter_map(|part| {
            let (factory_id, value) = part.split_once(':')?;
            let n = value.parse::<i64>().ok()?.max(1);
            (!factory_id.trim().is_empty()).then(|| (factory_id.trim().to_string(), n))
        })
        .collect()
}

fn start_limit_for_factory(
    factory_id: &str,
    default_starts_per_week: i64,
    factory_start_limits: &HashMap<String, i64>,
) -> i64 {
    factory_start_limits
        .get(factory_id)
        .copied()
        .unwrap_or(default_starts_per_week)
        .max(1)
}

fn parse_factory_percent_limits(raw: Option<&str>) -> HashMap<String, f64> {
    raw.unwrap_or("")
        .split(',')
        .filter_map(|part| {
            let (factory_id, value) = part.split_once(':')?;
            let n = value.parse::<f64>().ok()?;
            n.is_finite()
                .then(|| (factory_id.trim().to_string(), n.clamp(-95.0, 500.0)))
        })
        .filter(|(factory_id, _)| !factory_id.is_empty())
        .collect()
}

fn parse_factory_day_limits(raw: Option<&str>) -> HashMap<String, i64> {
    raw.unwrap_or("")
        .split(',')
        .filter_map(|part| {
            let (factory_id, value) = part.split_once(':')?;
            let n = value.parse::<i64>().ok()?.clamp(-365, 3650);
            (!factory_id.trim().is_empty()).then(|| (factory_id.trim().to_string(), n))
        })
        .collect()
}

fn lead_time_pct_for_factory(
    factory_id: &str,
    default_pct: f64,
    factory_lead_time_limits: &HashMap<String, f64>,
) -> f64 {
    factory_lead_time_limits
        .get(factory_id)
        .copied()
        .unwrap_or(default_pct)
        .clamp(-95.0, 500.0)
}

fn lead_time_days_for_factory(
    factory_id: &str,
    default_days: i64,
    factory_lead_time_day_limits: &HashMap<String, i64>,
) -> i64 {
    factory_lead_time_day_limits
        .get(factory_id)
        .copied()
        .unwrap_or(default_days)
        .clamp(-365, 3650)
}

fn adjusted_cycle_time_days(base_days: i64, pct: f64, day_offset: i64) -> i64 {
    (((base_days.max(1) as f64) * (1.0 + pct / 100.0)).round() as i64 + day_offset).max(1)
}

const MAX_SYNC_RECOMMENDATION_UNITS: usize = 500;

/// Parse a stored serial-list (newline-separated, e.g. pasted from Excel) into
/// positional entries. Internal blanks are kept (they map to no serial);
/// trailing blank lines are dropped.
fn parse_serial_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = raw
        .replace('\r', "\n")
        .split('\n')
        .map(|s| s.trim().to_string())
        .collect();
    while out.last().map(|s| s.is_empty()).unwrap_or(false) {
        out.pop();
    }
    out
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(run_scenario)
        .service(list_scenario_runs)
        .service(get_run);
}

#[derive(Serialize)]
pub struct RunResponse {
    pub run: ScheduleRun,
    pub units: Vec<ScheduledUnit>,
    pub recommendation: RecommendationOut,
    pub quarter_misses: Vec<QuarterMissRow>,
    #[serde(default)]
    pub alternatives: Vec<RunAlternative>,
}

#[derive(Serialize)]
pub struct RunAlternative {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub total_demand: i64,
    pub shipped_on_time: i64,
    pub shipped_late: i64,
    pub unshippable: i64,
    pub units: Vec<ScheduledUnit>,
}

pub(crate) async fn load_schedule_input(
    pool: &Pool,
    scenario_id: &str,
) -> AppResult<ScheduleInput> {
    // factories + per-quarter bay-count overrides
    let factory_rows = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    let mut factories: Vec<FactoryInput> = Vec::with_capacity(factory_rows.len());
    for f in factory_rows {
        let bcs = sqlx::query_as::<_, BayCountRow>(
            "SELECT id, factory_id, year, quarter, bays FROM factory_bay_count WHERE factory_id = $1",
        )
        .bind(&f.id)
        .fetch_all(pool)
        .await?;
        let bws = sqlx::query_as::<_, BayWeekRow>(
            "SELECT id, factory_id, week_start, bays FROM factory_bay_week WHERE factory_id = $1",
        )
        .bind(&f.id)
        .fetch_all(pool)
        .await?;
        let bay_counts_by_week = bws
            .into_iter()
            .filter_map(|b| {
                NaiveDate::parse_from_str(&b.week_start, "%Y-%m-%d")
                    .ok()
                    .map(|week_start| BayWeekInput {
                        week_start,
                        bays: b.bays,
                    })
            })
            .collect();
        factories.push(FactoryInput {
            id: f.id,
            name: f.name,
            bays: f.bays,
            changeover_days: f.changeover_days,
            bay_counts_by_quarter: bcs
                .into_iter()
                .map(|b| BayCountInput {
                    year: b.year,
                    quarter: b.quarter,
                    bays: b.bays,
                })
                .collect(),
            bay_counts_by_week,
        });
    }

    // products + lead times
    let products_rows = sqlx::query_as::<_, ProductRow>(
        "SELECT id, scenario_id, name FROM product WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    let mut products: Vec<ProductInput> = Vec::with_capacity(products_rows.len());
    for p in products_rows {
        let lts = sqlx::query_as::<_, LeadTimeRow>(
            "SELECT id, product_id, year, quarter, lead_time_days FROM product_lead_time WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        let flts = sqlx::query_as::<_, FactoryLeadTimeRow>(
            "SELECT id, product_id, factory_id, year, quarter, lead_time_days FROM product_factory_lead_time WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        let allocs = sqlx::query_as::<_, FactoryAllocationRow>(
            "SELECT id, product_id, factory_id, year, quarter, allocation_pct FROM product_factory_allocation WHERE product_id = $1",
        )
        .bind(&p.id)
        .fetch_all(pool)
        .await?;
        products.push(ProductInput {
            id: p.id,
            name: p.name,
            lead_times: lts
                .into_iter()
                .map(|l| LeadTimeInput {
                    year: l.year,
                    quarter: l.quarter,
                    lead_time_days: l.lead_time_days,
                })
                .collect(),
            factory_lead_times: flts
                .into_iter()
                .map(|l| FactoryLeadTimeInput {
                    factory_id: l.factory_id,
                    year: l.year,
                    quarter: l.quarter,
                    lead_time_days: l.lead_time_days,
                })
                .collect(),
            factory_allocations: allocs
                .into_iter()
                .map(|a| FactoryAllocationInput {
                    factory_id: a.factory_id,
                    year: a.year,
                    quarter: a.quarter,
                    allocation_pct: a.allocation_pct,
                })
                .collect(),
        });
    }

    // demand
    let demand_rows = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1 ORDER BY year, period_index",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;

    Ok(ScheduleInput {
        factories,
        products,
        demand: demand_rows
            .into_iter()
            .map(|d| DemandInput {
                id: d.id,
                product_id: d.product_id,
                period_type: d.period_type,
                year: d.year,
                period_index: d.period_index,
                quantity: d.quantity,
                spread_mode: d.spread_mode,
            })
            .collect(),
    })
}

#[derive(Debug, Clone)]
struct AsapFactory {
    id: String,
    changeover_days: i64,
    weekly_bays: BTreeMap<NaiveDate, i64>,
}

fn bay_count_on(f: &AsapFactory, date: NaiveDate) -> i64 {
    if let Some((&week_start, &bays)) = f.weekly_bays.range(..=date).next_back() {
        if date <= week_start + Duration::days(6) {
            return bays.max(0);
        }
    }
    0
}

fn min_bays_in_window(f: &AsapFactory, start: NaiveDate, end: NaiveDate) -> i64 {
    let mut d = start;
    let mut min_bays = bay_count_on(f, d);
    while d < end {
        d += Duration::days(1);
        min_bays = min_bays.min(bay_count_on(f, d));
    }
    min_bays
}

fn window_available(
    intervals: &[(NaiveDate, NaiveDate)],
    start: NaiveDate,
    end: NaiveDate,
    changeover_days: i64,
) -> bool {
    let gap = changeover_days.max(0);
    intervals.iter().all(|(s, e)| {
        let blocked_start = *s - Duration::days(gap);
        let blocked_end = *e + Duration::days(gap);
        blocked_end < start || blocked_start > end
    })
}

pub(crate) fn schedule_orders_linear_finish(
    factories: &[FactoryWithBayCounts],
    orders: &[ScenarioOrder],
    max_starts_per_week: Option<i64>,
    factory_start_limits: &HashMap<String, i64>,
    lead_time_pct: f64,
    factory_lead_time_limits: &HashMap<String, f64>,
    lead_time_days: i64,
    factory_lead_time_day_limits: &HashMap<String, i64>,
) -> AppResult<Vec<ScheduledUnit>> {
    if orders.is_empty() {
        return Ok(Vec::new());
    }
    let mut facs: Vec<AsapFactory> = Vec::new();
    let mut horizon_start: Option<NaiveDate> = None;
    let mut latest_week: Option<NaiveDate> = None;
    for f in factories {
        let mut weekly_bays = BTreeMap::new();
        for w in &f.bay_weeks {
            let d = NaiveDate::parse_from_str(&w.week_start, "%Y-%m-%d").map_err(|_| {
                AppError::BadRequest(format!(
                    "invalid week_start {} for factory {}",
                    w.week_start, f.name
                ))
            })?;
            horizon_start = Some(horizon_start.map_or(d, |cur| cur.min(d)));
            latest_week = Some(latest_week.map_or(d, |cur| cur.max(d)));
            weekly_bays.insert(d, w.bays.max(0));
        }
        facs.push(AsapFactory {
            id: f.id.clone(),
            changeover_days: f.changeover_days.max(0),
            weekly_bays,
        });
    }
    let Some(start_date) = horizon_start else {
        return Err(AppError::BadRequest(
            "enter weekly bay capacity for at least one factory".into(),
        ));
    };
    let horizon_finish = latest_week.unwrap_or(start_date) + Duration::days(6);
    let overflow_end = horizon_finish
        + Duration::days(
            orders
                .iter()
                .map(|o| {
                    facs.iter()
                        .map(|f| {
                            adjusted_cycle_time_days(
                                o.cycle_time_days,
                                lead_time_pct_for_factory(
                                    &f.id,
                                    lead_time_pct,
                                    factory_lead_time_limits,
                                ),
                                lead_time_days_for_factory(
                                    &f.id,
                                    lead_time_days,
                                    factory_lead_time_day_limits,
                                ),
                            )
                        })
                        .max()
                        .unwrap_or_else(|| {
                            adjusted_cycle_time_days(
                                o.cycle_time_days,
                                lead_time_pct,
                                lead_time_days,
                            )
                        })
                })
                .sum::<i64>()
                + 365,
        );
    let capacity_weeks =
        ((latest_week.unwrap_or(start_date) - start_date).num_days() / 7 + 1).max(1);
    let starts_per_week = max_starts_per_week
        .filter(|n| *n > 0)
        .unwrap_or_else(|| ((orders.len() as i64 + capacity_weeks - 1) / capacity_weeks).max(1));
    let mut reservations: HashMap<(String, i64), Vec<(NaiveDate, NaiveDate)>> = HashMap::new();
    let mut launches_by_factory_week: HashMap<(String, i64), i64> = HashMap::new();
    let mut out = Vec::with_capacity(orders.len());

    for (idx, o) in orders.iter().enumerate() {
        let idx = idx as i64;
        let max_duration = facs
            .iter()
            .map(|f| {
                adjusted_cycle_time_days(
                    o.cycle_time_days,
                    lead_time_pct_for_factory(&f.id, lead_time_pct, factory_lead_time_limits),
                    lead_time_days_for_factory(&f.id, lead_time_days, factory_lead_time_day_limits),
                )
            })
            .max()
            .unwrap_or_else(|| {
                adjusted_cycle_time_days(o.cycle_time_days, lead_time_pct, lead_time_days)
            });

        let anchored_due_date = if let Some(due_date_str) = &o.due_date {
            Some(
                NaiveDate::parse_from_str(due_date_str, "%Y-%m-%d").map_err(|_| {
                    AppError::BadRequest(format!(
                        "invalid due_date {} for order {}",
                        due_date_str, o.utid
                    ))
                })?,
            )
        } else {
            None
        };

        let planned_start = if let Some(due_date) = anchored_due_date {
            (due_date - Duration::days(max_duration - 1)).max(start_date)
        } else {
            let week_bucket = idx / starts_per_week;
            let slot_in_week = idx % starts_per_week;
            let day_in_week = (slot_in_week * 7) / starts_per_week;
            start_date + Duration::days(week_bucket * 7 + day_in_week)
        };
        let fallback_target_finish = anchored_due_date.unwrap_or_else(|| {
            planned_start
                + Duration::days(
                    adjusted_cycle_time_days(o.cycle_time_days, lead_time_pct, lead_time_days) - 1,
                )
        });

        let is_anchored = o.due_date.is_some() || o.anchor_factory_id.is_some();
        let mut best: Option<(NaiveDate, NaiveDate, NaiveDate, String, i64)> = None;
        let mut s = planned_start;
        while s <= horizon_finish && best.is_none() {
            let week_idx = ((s - start_date).num_days()).div_euclid(7);
            if !is_anchored {
                let any_factory_has_launch_room = facs.iter().any(|f| {
                    if o.anchor_factory_id
                        .as_deref()
                        .is_some_and(|fid| fid != f.id)
                    {
                        return false;
                    }
                    let key = (f.id.clone(), week_idx);
                    let used = launches_by_factory_week.get(&key).copied().unwrap_or(0);
                    used < start_limit_for_factory(&f.id, starts_per_week, factory_start_limits)
                });
                if !any_factory_has_launch_room {
                    s = start_date + Duration::days((week_idx + 1) * 7);
                    continue;
                }
            }

            for f in &facs {
                if o.anchor_factory_id
                    .as_deref()
                    .is_some_and(|fid| fid != f.id)
                {
                    continue;
                }
                let duration = adjusted_cycle_time_days(
                    o.cycle_time_days,
                    lead_time_pct_for_factory(&f.id, lead_time_pct, factory_lead_time_limits),
                    lead_time_days_for_factory(&f.id, lead_time_days, factory_lead_time_day_limits),
                );
                let candidate_start = anchored_due_date
                    .map(|due_date| (due_date - Duration::days(duration - 1)).max(s))
                    .unwrap_or(s);
                let e = candidate_start + Duration::days(duration - 1);
                let target_finish = anchored_due_date.unwrap_or(e);
                if candidate_start > horizon_finish {
                    continue;
                }
                let candidate_week_idx = ((candidate_start - start_date).num_days()).div_euclid(7);
                if !is_anchored {
                    let key = (f.id.clone(), candidate_week_idx);
                    let used = launches_by_factory_week.get(&key).copied().unwrap_or(0);
                    if used >= start_limit_for_factory(&f.id, starts_per_week, factory_start_limits)
                    {
                        continue;
                    }
                }
                let cap = min_bays_in_window(f, candidate_start, e);
                for bay in 0..cap {
                    let key = (f.id.clone(), bay);
                    let intervals = reservations.entry(key.clone()).or_default();
                    if window_available(intervals, candidate_start, e, f.changeover_days) {
                        best = Some((candidate_start, e, target_finish, f.id.clone(), bay));
                        break;
                    }
                }
                if best.is_some() {
                    break;
                }
            }
            s += Duration::days(1);
        }

        if let Some((s, e, target_finish, fid, bay)) = best {
            reservations
                .entry((fid.clone(), bay))
                .or_default()
                .push((s, e));
            if !is_anchored {
                let week_idx = ((s - start_date).num_days()).div_euclid(7);
                *launches_by_factory_week
                    .entry((fid.clone(), week_idx))
                    .or_insert(0) += 1;
            }
            out.push(ScheduledUnit {
                id: new_id(),
                run_id: String::new(),
                demand_id: o.id.clone(),
                product_id: o.customer.clone(),
                factory_id: Some(fid),
                bay_index: Some(bay),
                required_start: s.to_string(),
                due_date: e.to_string(),
                status: "shipped".to_string(),
                serial: Some(o.utid.clone()),
                orig_due_date: Some(target_finish.to_string()),
                is_late: e > target_finish,
                is_anchored,
            });
        } else {
            out.push(ScheduledUnit {
                id: new_id(),
                run_id: String::new(),
                demand_id: o.id.clone(),
                product_id: o.customer.clone(),
                factory_id: None,
                bay_index: None,
                required_start: start_date.to_string(),
                due_date: overflow_end.to_string(),
                status: "unshippable".to_string(),
                serial: Some(o.utid.clone()),
                orig_due_date: Some(fallback_target_finish.to_string()),
                is_late: false,
                is_anchored,
            });
        }
    }
    Ok(out)
}

async fn run_orders_scenario(
    pool: &Pool,
    scenario_id: &str,
    orders: Vec<ScenarioOrder>,
    max_starts_per_week: Option<i64>,
    factory_start_limits: &HashMap<String, i64>,
    lead_time_pct: f64,
    factory_lead_time_limits: &HashMap<String, f64>,
    lead_time_days: i64,
    factory_lead_time_day_limits: &HashMap<String, i64>,
) -> AppResult<RunResponse> {
    let factory_rows = sqlx::query_as::<_, Factory>(
        "SELECT id, scenario_id, name, bays, changeover_days FROM factory WHERE scenario_id = $1 ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(pool)
    .await?;
    let mut factories = Vec::with_capacity(factory_rows.len());
    for f in factory_rows {
        factories.push(crate::handlers::factories::factory_with_bays(pool, f).await?);
    }
    let mut units = schedule_orders_linear_finish(
        &factories,
        &orders,
        max_starts_per_week,
        factory_start_limits,
        lead_time_pct,
        factory_lead_time_limits,
        lead_time_days,
        factory_lead_time_day_limits,
    )?;
    let run_id = new_id();
    let run_at = now_iso();
    let shipped = units.iter().filter(|u| u.status == "shipped").count() as i64;
    let unshippable = units.iter().filter(|u| u.status == "unshippable").count() as i64;

    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO schedule_run (id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(&run_id)
        .bind(scenario_id)
        .bind(&run_at)
        .bind(orders.len() as i64)
        .bind(shipped)
        .bind(0_i64)
        .bind(unshippable)
        .execute(&mut *tx)
        .await?;

    for u in &mut units {
        u.run_id = run_id.clone();
        sqlx::query("INSERT INTO scheduled_unit (id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late, is_anchored) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)")
            .bind(&u.id)
            .bind(&run_id)
            .bind(&u.demand_id)
            .bind(&u.product_id)
            .bind(u.factory_id.as_deref())
            .bind(u.bay_index)
            .bind(&u.required_start)
            .bind(&u.due_date)
            .bind(&u.status)
            .bind(&u.serial)
            .bind(&u.orig_due_date)
            .bind(u.is_late)
            .bind(u.is_anchored)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    Ok(RunResponse {
        run: ScheduleRun {
            id: run_id,
            scenario_id: scenario_id.to_string(),
            run_at,
            total_demand: orders.len() as i64,
            shipped_on_time: shipped,
            shipped_late: 0,
            unshippable,
        },
        units,
        recommendation: RecommendationOut::default(),
        quarter_misses: vec![],
        alternatives: vec![],
    })
}

#[post("/api/scenarios/{id}/run")]
async fn run_scenario(
    pool: web::Data<Pool>,
    path: web::Path<String>,
    query: web::Query<RunQuery>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let mode = query.assignment();

    // Verify scenario exists
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM scenario WHERE id = $1")
        .bind(&scenario_id)
        .fetch_optional(pool.get_ref())
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("scenario {scenario_id}")));
    }

    let orders = sqlx::query_as::<_, ScenarioOrder>(
        "SELECT id, scenario_id, utid, build_type, customer, cycle_time_days, sort_order, due_date, anchor_factory_id FROM scenario_order WHERE scenario_id = $1 ORDER BY sort_order, utid",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    if !orders.is_empty() {
        let factory_start_limits = query.factory_start_limits();
        let factory_lead_time_limits = query.factory_lead_time_limits();
        let factory_lead_time_day_limits = query.factory_lead_time_day_limits();
        return Ok(HttpResponse::Ok().json(
            run_orders_scenario(
                pool.get_ref(),
                &scenario_id,
                orders,
                query.max_starts_per_week,
                &factory_start_limits,
                query.lead_time_pct.unwrap_or(0.0),
                &factory_lead_time_limits,
                query.lead_time_days.unwrap_or(0),
                &factory_lead_time_day_limits,
            )
            .await?,
        ));
    }

    let input = load_schedule_input(pool.get_ref(), &scenario_id).await?;
    let output = run_schedule_mode(&input, mode);

    // Resolve per-unit serials from each demand row's serial config.
    let demand_rows = sqlx::query_as::<_, Demand>(
        "SELECT id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode, serial_mode, serial_start, serial_list FROM demand WHERE scenario_id = $1",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    let serial_for = assign_serials(&demand_rows, &output.units);

    // Keep the normal run fast: recommendations are global what-ifs and can be
    // expensive because they rerun the scheduler many times. Large overloaded
    // scenarios still save and return the schedule; users can inspect backlog
    // without waiting for hundreds of what-if simulations.
    let recommendation =
        if output.unshippable > 0 && output.total_demand <= MAX_SYNC_RECOMMENDATION_UNITS {
            compute_recommendations(&input, &output, mode)
        } else {
            RecommendationOut::default()
        };

    // Persist
    let run_id = new_id();
    let alternatives = build_alternatives(&input, &recommendation, mode, &demand_rows, &run_id);
    let run_at = now_iso();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO schedule_run (id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(&run_id)
        .bind(&scenario_id)
        .bind(&run_at)
        .bind(output.total_demand as i64)
        .bind(output.shipped_on_time as i64)
        .bind(output.shipped_late as i64)
        .bind(output.unshippable as i64)
        .execute(&mut *tx)
        .await?;

    for (i, u) in output.units.iter().enumerate() {
        // status stays 'shipped'|'unshippable'; lateness is a separate flag.
        let (status, is_late) = match u.status {
            UnitStatus::Shipped => ("shipped", false),
            UnitStatus::Late => ("shipped", true),
            UnitStatus::Unshippable => ("unshippable", false),
        };
        sqlx::query("INSERT INTO scheduled_unit (id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late, is_anchored) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)")
            .bind(new_id())
            .bind(&run_id)
            .bind(&u.demand_id)
            .bind(&u.product_id)
            .bind(u.factory_id.as_deref())
            .bind(u.bay_index)
            .bind(u.required_start.to_string())
            .bind(u.due_date.to_string())
            .bind(status)
            .bind(serial_for.get(i).cloned().flatten())
            .bind(u.orig_due_date.to_string())
            .bind(is_late)
            .bind(false)
            .execute(&mut *tx)
            .await?;
    }

    // Persist per-quarter miss counts.
    for m in &output.quarter_misses {
        sqlx::query("INSERT INTO quarter_miss (id, run_id, year, quarter, missed_count) VALUES ($1, $2, $3, $4, $5)")
            .bind(new_id())
            .bind(&run_id)
            .bind(m.year)
            .bind(m.quarter)
            .bind(m.count)
            .execute(&mut *tx)
            .await?;
    }

    // Persist recommendations (one row per type, payload JSON)
    persist_rec(&mut tx, &run_id, "bays_needed", &recommendation.bays_needed).await?;
    persist_rec(
        &mut tx,
        &run_id,
        "uniform_lt_pct",
        &recommendation.uniform_lt_pct,
    )
    .await?;
    persist_rec(
        &mut tx,
        &run_id,
        "per_product_lt",
        &recommendation.per_product_lt,
    )
    .await?;

    tx.commit().await?;

    let run = ScheduleRun {
        id: run_id.clone(),
        scenario_id: scenario_id.clone(),
        run_at,
        total_demand: output.total_demand as i64,
        shipped_on_time: output.shipped_on_time as i64,
        shipped_late: output.shipped_late as i64,
        unshippable: output.unshippable as i64,
    };

    let units = load_units(pool.get_ref(), &run_id).await?;
    let quarter_misses = load_quarter_misses(pool.get_ref(), &run_id).await?;

    Ok(HttpResponse::Ok().json(RunResponse {
        run,
        units,
        recommendation,
        quarter_misses,
        alternatives,
    }))
}

#[get("/api/scenarios/{id}/runs")]
async fn list_scenario_runs(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse> {
    let scenario_id = path.into_inner();
    let rows = sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable FROM schedule_run WHERE scenario_id = $1 ORDER BY run_at DESC LIMIT 50",
    )
    .bind(&scenario_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(rows))
}

#[get("/api/runs/{id}")]
async fn get_run(pool: web::Data<Pool>, path: web::Path<String>) -> AppResult<HttpResponse> {
    let run_id = path.into_inner();
    let run = sqlx::query_as::<_, ScheduleRun>(
        "SELECT id, scenario_id, run_at, total_demand, shipped_on_time, shipped_late, unshippable FROM schedule_run WHERE id = $1",
    )
    .bind(&run_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound(format!("run {run_id}")))?;

    let units = load_units(pool.get_ref(), &run_id).await?;

    let recs = sqlx::query_as::<_, RecommendationRow>(
        "SELECT id, run_id, rec_type, payload_json FROM recommendation WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut recommendation = RecommendationOut::default();
    for r in recs {
        match r.rec_type.as_str() {
            "bays_needed" => {
                recommendation.bays_needed = serde_json::from_str(&r.payload_json).ok().flatten();
            }
            "uniform_lt_pct" => {
                recommendation.uniform_lt_pct =
                    serde_json::from_str(&r.payload_json).ok().flatten();
            }
            "per_product_lt" => {
                recommendation.per_product_lt = serde_json::from_str(&r.payload_json)
                    .ok()
                    .unwrap_or_default();
            }
            _ => {}
        }
    }

    let quarter_misses = load_quarter_misses(pool.get_ref(), &run_id).await?;

    Ok(HttpResponse::Ok().json(RunResponse {
        run,
        units,
        recommendation,
        quarter_misses,
        alternatives: vec![],
    }))
}

fn build_alternatives(
    input: &ScheduleInput,
    recommendation: &RecommendationOut,
    mode: BayAssignment,
    demand_rows: &[Demand],
    base_run_id: &str,
) -> Vec<RunAlternative> {
    let mut out = Vec::new();

    if let Some(b) = &recommendation.bays_needed {
        if let Some(target_id) = &b.suggested_factory_id {
            let mut trial = input.clone();
            for f in trial.factories.iter_mut() {
                if &f.id == target_id {
                    f.bays += b.bays_to_add;
                    break;
                }
            }
            let alt = run_schedule_mode(&trial, mode);
            out.push(alt_response(
                "bays",
                "Add bays",
                format!(
                    "Add {} bay{} to {}",
                    b.bays_to_add,
                    if b.bays_to_add == 1 { "" } else { "s" },
                    b.suggested_factory_name
                        .as_deref()
                        .unwrap_or("the busiest factory")
                ),
                &format!("{base_run_id}:alt:bays"),
                &alt,
                demand_rows,
            ));
        }
    }

    if let Some(u) = &recommendation.uniform_lt_pct {
        let scale = (1.0 - (u.reduction_pct / 100.0)).max(0.01);
        let alt = run_schedule_with_lt_mode(
            input,
            |_pid, lt| ((lt as f64) * scale).round().max(1.0) as i64,
            mode,
        );
        out.push(alt_response(
            "ct",
            "Reduce cycle time",
            format!("Reduce all cycle times by {:.1}%", u.reduction_pct),
            &format!("{base_run_id}:alt:ct"),
            &alt,
            demand_rows,
        ));
    }

    out
}

fn alt_response(
    kind: &str,
    label: &str,
    description: String,
    run_id: &str,
    output: &ScheduleOutput,
    demand_rows: &[Demand],
) -> RunAlternative {
    let serial_for = assign_serials(demand_rows, &output.units);
    RunAlternative {
        kind: kind.to_string(),
        label: label.to_string(),
        description,
        total_demand: output.total_demand as i64,
        shipped_on_time: output.shipped_on_time as i64,
        shipped_late: output.shipped_late as i64,
        unshippable: output.unshippable as i64,
        units: output_units_to_api(run_id, output, &serial_for),
    }
}

fn output_units_to_api(
    run_id: &str,
    output: &ScheduleOutput,
    serial_for: &[Option<String>],
) -> Vec<ScheduledUnit> {
    output
        .units
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let (status, is_late) = match u.status {
                UnitStatus::Shipped => ("shipped", false),
                UnitStatus::Late => ("shipped", true),
                UnitStatus::Unshippable => ("unshippable", false),
            };
            ScheduledUnit {
                id: format!("{run_id}:{i}"),
                run_id: run_id.to_string(),
                demand_id: u.demand_id.clone(),
                product_id: u.product_id.clone(),
                factory_id: u.factory_id.clone(),
                bay_index: u.bay_index,
                required_start: u.required_start.to_string(),
                due_date: u.due_date.to_string(),
                status: status.to_string(),
                serial: serial_for.get(i).cloned().flatten(),
                orig_due_date: Some(u.orig_due_date.to_string()),
                is_late,
                is_anchored: false,
            }
        })
        .collect()
}

async fn load_units(pool: &Pool, run_id: &str) -> AppResult<Vec<ScheduledUnit>> {
    let units = sqlx::query_as::<_, ScheduledUnit>(
        "SELECT id, run_id, demand_id, product_id, factory_id, bay_index, required_start, due_date, status, serial, orig_due_date, is_late, is_anchored FROM scheduled_unit WHERE run_id = $1 ORDER BY due_date",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    Ok(units)
}

async fn load_quarter_misses(pool: &Pool, run_id: &str) -> AppResult<Vec<QuarterMissRow>> {
    let rows = sqlx::query_as::<_, QuarterMissRow>(
        "SELECT id, run_id, year, quarter, missed_count FROM quarter_miss WHERE run_id = $1 ORDER BY year, quarter",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Map each output unit to its serial. Serials are generated per demand row and
/// assigned positionally in due-date order (matching the explosion order).
fn assign_serials(
    demand_rows: &[Demand],
    units: &[crate::scheduling::ScheduledUnitOut],
) -> Vec<Option<String>> {
    let mut serials_by_demand: HashMap<&str, Vec<Option<String>>> = HashMap::new();
    for d in demand_rows {
        let list = d
            .serial_list
            .as_deref()
            .map(parse_serial_list)
            .unwrap_or_default();
        let serials = generate_serials(
            &d.serial_mode,
            d.serial_start.as_deref(),
            &list,
            d.quantity.max(0) as usize,
        );
        serials_by_demand.insert(d.id.as_str(), serials);
    }

    let mut idxs_by_demand: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        idxs_by_demand
            .entry(u.demand_id.as_str())
            .or_default()
            .push(i);
    }

    let mut serial_for = vec![None; units.len()];
    for (did, mut idxs) in idxs_by_demand {
        idxs.sort_by(|&a, &b| units[a].due_date.cmp(&units[b].due_date));
        if let Some(serials) = serials_by_demand.get(did) {
            for (k, &i) in idxs.iter().enumerate() {
                serial_for[i] = serials.get(k).cloned().flatten();
            }
        }
    }
    serial_for
}

async fn persist_rec<T: serde::Serialize>(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run_id: &str,
    rec_type: &str,
    payload: &T,
) -> AppResult<()> {
    let json = serde_json::to_string(payload)
        .map_err(|e| AppError::Internal(format!("serialize {rec_type}: {e}")))?;
    sqlx::query(
        "INSERT INTO recommendation (id, run_id, rec_type, payload_json) VALUES ($1, $2, $3, $4)",
    )
    .bind(new_id())
    .bind(run_id)
    .bind(rec_type)
    .bind(&json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn factory() -> FactoryWithBayCounts {
        factory_with_id("f1")
    }

    fn factory_with_id(id: &str) -> FactoryWithBayCounts {
        FactoryWithBayCounts {
            id: id.into(),
            scenario_id: "s1".into(),
            name: id.to_string(),
            bays: 0,
            changeover_days: 0,
            bay_counts: vec![],
            bay_weeks: vec![
                BayWeekRow {
                    id: "w1".into(),
                    factory_id: id.into(),
                    week_start: "2026-08-02".into(),
                    bays: 10,
                },
                BayWeekRow {
                    id: "w2".into(),
                    factory_id: id.into(),
                    week_start: "2026-08-09".into(),
                    bays: 10,
                },
                BayWeekRow {
                    id: "w3".into(),
                    factory_id: id.into(),
                    week_start: "2026-08-16".into(),
                    bays: 10,
                },
                BayWeekRow {
                    id: "w4".into(),
                    factory_id: id.into(),
                    week_start: "2026-08-23".into(),
                    bays: 10,
                },
            ],
        }
    }

    fn order(i: usize) -> ScenarioOrder {
        ScenarioOrder {
            id: format!("o{i}"),
            scenario_id: "s1".into(),
            utid: format!("U{i}"),
            build_type: "BT".into(),
            customer: "C".into(),
            cycle_time_days: 1,
            sort_order: i as i64,
            due_date: None,
            anchor_factory_id: None,
        }
    }

    #[test]
    fn plan_orders_start_linearly_across_capacity_horizon() {
        let orders = vec![order(1), order(2), order(3), order(4)];
        let units = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            None,
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let starts: Vec<_> = units.iter().map(|u| u.required_start.as_str()).collect();
        let finishes: Vec<_> = units.iter().map(|u| u.due_date.as_str()).collect();
        assert_eq!(
            starts,
            vec!["2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23"]
        );
        assert_eq!(finishes, starts);
    }

    #[test]
    fn plan_orders_respect_explicit_weekly_start_cap() {
        let orders = vec![order(1), order(2), order(3), order(4)];
        let units = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(2),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let starts: Vec<_> = units.iter().map(|u| u.required_start.as_str()).collect();
        assert_eq!(
            starts,
            vec!["2026-08-02", "2026-08-05", "2026-08-09", "2026-08-12"]
        );
    }

    #[test]
    fn plan_orders_respect_factory_changeover_days() {
        let mut f = factory();
        f.changeover_days = 2;
        for w in &mut f.bay_weeks {
            w.bays = 1;
        }
        let mut orders = vec![order(1), order(2)];
        for o in &mut orders {
            o.cycle_time_days = 2;
        }
        let units = schedule_orders_linear_finish(
            &[f],
            &orders,
            Some(10),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let starts: Vec<_> = units.iter().map(|u| u.required_start.as_str()).collect();
        let finishes: Vec<_> = units.iter().map(|u| u.due_date.as_str()).collect();
        assert_eq!(starts, vec!["2026-08-02", "2026-08-06"]);
        assert_eq!(finishes, vec!["2026-08-03", "2026-08-07"]);
    }

    #[test]
    fn plan_orders_apply_global_lead_time_percent() {
        let mut o = order(1);
        o.cycle_time_days = 10;
        let units = schedule_orders_linear_finish(
            &[factory()],
            &[o],
            Some(1),
            &HashMap::new(),
            50.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(units[0].required_start, "2026-08-02");
        assert_eq!(units[0].due_date, "2026-08-16");
    }

    #[test]
    fn plan_orders_apply_global_lead_time_days() {
        let mut o = order(1);
        o.cycle_time_days = 10;
        let units = schedule_orders_linear_finish(
            &[factory()],
            &[o],
            Some(1),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            -3,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(units[0].required_start, "2026-08-02");
        assert_eq!(units[0].due_date, "2026-08-08");
    }

    #[test]
    fn plan_orders_apply_factory_lead_time_percent_override() {
        let mut anchored = order(1);
        anchored.cycle_time_days = 2;
        anchored.due_date = Some("2026-08-08".into());
        anchored.anchor_factory_id = Some("f2".into());
        let mut overrides = HashMap::new();
        overrides.insert("f2".to_string(), 100.0);
        let units = schedule_orders_linear_finish(
            &[factory_with_id("f1"), factory_with_id("f2")],
            &[anchored],
            Some(1),
            &HashMap::new(),
            0.0,
            &overrides,
            0,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(units[0].factory_id.as_deref(), Some("f2"));
        assert_eq!(units[0].required_start, "2026-08-05");
        assert_eq!(units[0].due_date, "2026-08-08");
    }

    #[test]
    fn anchored_factory_places_order_on_selected_factory() {
        let mut anchored = order(1);
        anchored.due_date = Some("2026-08-02".into());
        anchored.anchor_factory_id = Some("f2".into());
        let units = schedule_orders_linear_finish(
            &[factory_with_id("f1"), factory_with_id("f2")],
            &[anchored],
            Some(1),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(units[0].factory_id.as_deref(), Some("f2"));
        assert!(units[0].is_anchored);
    }

    #[test]
    fn one_weekly_start_cap_places_one_launch_per_week() {
        let orders: Vec<_> = (1..=4).map(order).collect();
        let units = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(1),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let starts: Vec<_> = units.iter().map(|u| u.required_start.as_str()).collect();
        assert_eq!(
            starts,
            vec!["2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23"]
        );
    }

    #[test]
    fn one_weekly_start_cap_shortfalls_past_capacity_horizon() {
        let orders: Vec<_> = (1..=6).map(order).collect();
        let units = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(1),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let shipped_starts: Vec<_> = units
            .iter()
            .filter(|u| u.status == "shipped")
            .map(|u| u.required_start.as_str())
            .collect();
        assert_eq!(
            shipped_starts,
            vec!["2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23"]
        );
        assert_eq!(
            units.iter().filter(|u| u.status == "unshippable").count(),
            2
        );
    }

    #[test]
    fn plan_orders_change_when_weekly_start_cap_changes() {
        let orders: Vec<_> = (1..=10).map(order).collect();
        let auto = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            None,
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let one = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(1),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let two = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(2),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let ten = schedule_orders_linear_finish(
            &[factory()],
            &orders,
            Some(10),
            &HashMap::new(),
            0.0,
            &HashMap::new(),
            0,
            &HashMap::new(),
        )
        .unwrap();
        let starts = |units: Vec<ScheduledUnit>| {
            units
                .into_iter()
                .filter(|u| u.status == "shipped")
                .map(|u| u.required_start)
                .collect::<Vec<_>>()
        };
        let auto_starts = starts(auto);
        let one_starts = starts(one);
        let two_starts = starts(two);
        let ten_starts = starts(ten);
        assert_ne!(auto_starts, one_starts);
        assert_ne!(auto_starts, two_starts);
        assert_ne!(auto_starts, ten_starts);
        assert_ne!(one_starts, ten_starts);
        assert_eq!(
            ten_starts[..4],
            ["2026-08-02", "2026-08-02", "2026-08-03", "2026-08-04"]
        );
    }
}

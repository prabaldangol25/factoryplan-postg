//! Recommendation engine — see docs/PLAN.md §4 for the three flavors:
//!   1. bays_needed     – min added bays that clears shortfall
//!   2. uniform_lt_pct  – min uniform % LT reduction that clears shortfall
//!   3. per_product_lt  – per product, min LT-scale that lets all its units fit
//!
//! All three use binary search around re-runs of the scheduler.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::scheduling::{
    run_schedule_mode, run_schedule_with_lt_mode, BayAssignment, FactoryInput, ScheduleInput,
    ScheduleOutput,
};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RecommendationOut {
    pub bays_needed: Option<BaysNeededRec>,
    pub uniform_lt_pct: Option<UniformLtPctRec>,
    #[serde(default)]
    pub per_product_lt: Vec<PerProductLtTarget>,
    #[serde(default)]
    pub quarter_fixes: Vec<QuarterFixRec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaysNeededRec {
    pub bays_to_add: i64,
    pub suggested_factory_id: Option<String>,
    pub suggested_factory_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniformLtPctRec {
    /// Reduction in percent, e.g. 12.5 means "reduce all LTs by 12.5%".
    pub reduction_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerProductLtTarget {
    pub product_id: String,
    pub product_name: String,
    /// Maximum lead time across that product's quarter matrix (for human display).
    pub current_lead_time_days: i64,
    /// Recommended max lead time the product should hit (uniformly scaled down).
    pub target_lead_time_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuarterFixRec {
    pub year: i64,
    pub quarter: i64,
    pub missed_count: i64,
    pub bays_to_add: Option<i64>,
    pub suggested_factory_id: Option<String>,
    pub suggested_factory_name: Option<String>,
    pub ct_reduction_pct: Option<f64>,
    pub ct_capacity_bound: bool,
}

const MAX_BAYS_TO_ADD: i64 = 256;
const MAX_PCT_ITER: u32 = 24;

/// Top-level entry point. Returns all three recommendations.
pub fn compute_recommendations(
    input: &ScheduleInput,
    failed_output: &ScheduleOutput,
    mode: BayAssignment,
) -> RecommendationOut {
    let bays_needed = compute_bays_needed(input, failed_output, mode);
    let uniform_lt_pct = compute_uniform_lt_pct(input, mode);
    let per_product_lt = compute_per_product_lt(input, mode);
    let quarter_fixes = compute_quarter_fixes(failed_output);

    RecommendationOut {
        bays_needed,
        uniform_lt_pct,
        per_product_lt,
        quarter_fixes,
    }
}

// ---------- 1. Bays needed ----------

fn pick_busiest_factory(input: &ScheduleInput, output: &ScheduleOutput) -> Option<FactoryInput> {
    let mut usage: HashMap<String, i64> = HashMap::new();
    for u in &output.units {
        if let Some(fid) = &u.factory_id {
            let span = (u.due_date - u.required_start).num_days() + 1;
            *usage.entry(fid.clone()).or_insert(0) += span;
        }
    }
    let busiest_id = usage
        .into_iter()
        .max_by_key(|(_, v)| *v)
        .map(|(k, _)| k)
        .or_else(|| input.factories.first().map(|f| f.id.clone()))?;
    input.factories.iter().find(|f| f.id == busiest_id).cloned()
}

fn compute_bays_needed(
    input: &ScheduleInput,
    failed_output: &ScheduleOutput,
    mode: BayAssignment,
) -> Option<BaysNeededRec> {
    if failed_output.not_on_time() == 0 {
        return None;
    }
    let target_factory = pick_busiest_factory(input, failed_output)?;
    let target_id = target_factory.id.clone();

    // Linearly grow bays until shortfall clears or we hit the cap. The cost is
    // cheap because we re-run scheduling against a modest dataset.
    for n in 1..=MAX_BAYS_TO_ADD {
        let mut trial = input.clone();
        for f in trial.factories.iter_mut() {
            if f.id == target_id {
                f.bays += n;
                break;
            }
        }
        let out = run_schedule_mode(&trial, mode);
        if out.not_on_time() == 0 {
            return Some(BaysNeededRec {
                bays_to_add: n,
                suggested_factory_id: Some(target_factory.id),
                suggested_factory_name: Some(target_factory.name),
            });
        }
    }
    // Couldn't clear even with MAX_BAYS_TO_ADD — report that
    Some(BaysNeededRec {
        bays_to_add: MAX_BAYS_TO_ADD,
        suggested_factory_id: Some(target_factory.id),
        suggested_factory_name: Some(target_factory.name),
    })
}

// ---------- Per-quarter marginal fixes ----------

fn compute_quarter_fixes(failed_output: &ScheduleOutput) -> Vec<QuarterFixRec> {
    let mut misses = failed_output.quarter_misses.clone();
    misses.sort_by_key(|m| (m.year, m.quarter));
    misses
        .into_iter()
        .filter(|m| m.count > 0)
        .map(|m| QuarterFixRec {
            year: m.year,
            quarter: m.quarter,
            missed_count: m.count,
            bays_to_add: None,
            suggested_factory_id: None,
            suggested_factory_name: None,
            ct_reduction_pct: None,
            ct_capacity_bound: false,
        })
        .collect()
}

// ---------- 2. Uniform LT % reduction ----------

fn schedule_with_uniform_scale(
    input: &ScheduleInput,
    scale: f64,
    mode: BayAssignment,
) -> ScheduleOutput {
    run_schedule_with_lt_mode(
        input,
        |_pid, lt| ((lt as f64) * scale).round().max(1.0) as i64,
        mode,
    )
}

/// Returns minimum percent reduction (e.g. 12.5 = reduce all LTs by 12.5%) such
/// that all demand ships on time. Binary search over scale ∈ [low, 1.0].
fn compute_uniform_lt_pct(input: &ScheduleInput, mode: BayAssignment) -> Option<UniformLtPctRec> {
    // Check that scale=1.0 actually fails (otherwise no rec needed)
    let baseline = run_schedule_mode(input, mode);
    if baseline.not_on_time() == 0 {
        return None;
    }
    // Check that even scale=0.01 doesn't help (impossible-bays case)
    let extreme = schedule_with_uniform_scale(input, 0.01, mode);
    if extreme.not_on_time() > 0 {
        // Even with effectively-zero LTs we still can't ship — capacity is the
        // bottleneck, not lead time. Don't return a misleading recommendation.
        return None;
    }

    let mut lo = 0.01_f64;
    let mut hi = 1.0_f64;
    let mut best = lo;
    for _ in 0..MAX_PCT_ITER {
        let mid = (lo + hi) / 2.0;
        let out = schedule_with_uniform_scale(input, mid, mode);
        if out.not_on_time() == 0 {
            best = mid; // works at mid
            lo = mid; // try a larger (= less aggressive cut)
        } else {
            hi = mid;
        }
    }
    let reduction_pct = ((1.0 - best) * 100.0 * 10.0).round() / 10.0; // 1 decimal place
    Some(UniformLtPctRec { reduction_pct })
}

// ---------- 3. Per-product LT targets ----------

fn schedule_with_product_scales(
    input: &ScheduleInput,
    scales: &HashMap<String, f64>,
    mode: BayAssignment,
) -> ScheduleOutput {
    run_schedule_with_lt_mode(
        input,
        |pid, lt| {
            let s = scales.get(pid).copied().unwrap_or(1.0);
            ((lt as f64) * s).round().max(1.0) as i64
        },
        mode,
    )
}

/// For each product, find min scale ∈ (0, 1] holding others at their best-known
/// scale such that all demand ships on time. Greedy coordinate descent — not
/// globally optimal but fast and useful in practice.
fn compute_per_product_lt(input: &ScheduleInput, mode: BayAssignment) -> Vec<PerProductLtTarget> {
    let baseline = run_schedule_mode(input, mode);
    if baseline.not_on_time() == 0 {
        return vec![];
    }

    // Start with all scales = 1.0
    let mut scales: HashMap<String, f64> = input
        .products
        .iter()
        .map(|p| (p.id.clone(), 1.0_f64))
        .collect();

    // For each product, binary-search the largest scale (least aggressive cut)
    // that — together with the current best of the others — clears the shortfall.
    // Process products in order of "most demand" first.
    let mut demand_by_product: HashMap<String, i64> = HashMap::new();
    for d in &input.demand {
        *demand_by_product.entry(d.product_id.clone()).or_insert(0) += d.quantity;
    }
    let mut order: Vec<&str> = input.products.iter().map(|p| p.id.as_str()).collect();
    order.sort_by_key(|pid| std::cmp::Reverse(demand_by_product.get(*pid).copied().unwrap_or(0)));

    for pid in order {
        // Confirm shortfall persists; if it doesn't, this product needn't change
        let current = schedule_with_product_scales(input, &scales, mode);
        if current.not_on_time() == 0 {
            break;
        }

        // Binary search the scale for this product, holding others at current values
        let mut lo = 0.01_f64;
        let mut hi = 1.0_f64;
        let mut best = lo;
        let mut found_feasible = false;
        for _ in 0..MAX_PCT_ITER {
            let mid = (lo + hi) / 2.0;
            let mut trial = scales.clone();
            trial.insert(pid.to_string(), mid);
            let out = schedule_with_product_scales(input, &trial, mode);
            if out.not_on_time() == 0 {
                best = mid;
                lo = mid; // try less aggressive
                found_feasible = true;
            } else {
                hi = mid;
            }
        }
        if found_feasible {
            scales.insert(pid.to_string(), best);
        } else {
            // Even at near-zero scale this product alone couldn't clear the shortfall;
            // capacity is the bottleneck. Leave others' scales as-is and bail.
            return vec![];
        }
    }

    // Translate scales into target lead-time days (using each product's *max* LT
    // as the headline number)
    input
        .products
        .iter()
        .filter_map(|p| {
            let scale = scales.get(&p.id).copied().unwrap_or(1.0);
            // If we never had to reduce this product, skip it from the output
            if (scale - 1.0).abs() < 1e-6 {
                return None;
            }
            let current_max = p
                .lead_times
                .iter()
                .map(|l| l.lead_time_days)
                .max()
                .unwrap_or(0);
            let target = ((current_max as f64) * scale).round().max(1.0) as i64;
            Some(PerProductLtTarget {
                product_id: p.id.clone(),
                product_name: p.name.clone(),
                current_lead_time_days: current_max,
                target_lead_time_days: target,
            })
        })
        .collect()
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduling::{DemandInput, FactoryInput, LeadTimeInput, ProductInput};

    fn scenario_capacity_short() -> ScheduleInput {
        // 1 bay, 3 units all needing same window → 2 unshippable.
        // Reducing LT doesn't fix this (still all need full window simultaneously).
        ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
                bay_counts_by_week: vec![],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times: vec![LeadTimeInput {
                    year: 2026,
                    quarter: 3,
                    lead_time_days: 5,
                }],
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: 2026,
                period_index: 3,
                quantity: 3,
                spread_mode: "end".into(),
            }],
        }
    }

    fn scenario_lt_too_long() -> ScheduleInput {
        // 1 bay, 4 units evenly spread, LT = 60 days (way too long for 91-day quarter)
        // Reducing LT will fix this.
        ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
                bay_counts_by_week: vec![],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times: vec![LeadTimeInput {
                    year: 2026,
                    quarter: 3,
                    lead_time_days: 60,
                }],
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: 2026,
                period_index: 3,
                quantity: 4,
                spread_mode: "even".into(),
            }],
        }
    }

    #[test]
    fn bays_needed_capacity_short() {
        let s = scenario_capacity_short();
        let m = BayAssignment::BalanceLoad;
        let out = run_schedule_mode(&s, m);
        assert!(out.not_on_time() > 0);
        let r = compute_bays_needed(&s, &out, m).expect("expected a rec");
        assert!(
            r.bays_to_add >= 2,
            "need at least 2 more bays; got {}",
            r.bays_to_add
        );
        assert_eq!(r.suggested_factory_id.as_deref(), Some("f1"));
    }

    #[test]
    fn uniform_lt_pct_lt_too_long() {
        let s = scenario_lt_too_long();
        let m = BayAssignment::BalanceLoad;
        let out = run_schedule_mode(&s, m);
        assert!(out.not_on_time() > 0);
        let r = compute_uniform_lt_pct(&s, m).expect("expected a rec");
        assert!(r.reduction_pct > 0.0 && r.reduction_pct < 100.0);
    }

    #[test]
    fn uniform_lt_pct_no_rec_when_capacity_bound() {
        // Capacity-bound: reducing LT doesn't help, so no rec.
        let s = scenario_capacity_short();
        let r = compute_uniform_lt_pct(&s, BayAssignment::BalanceLoad);
        assert!(
            r.is_none(),
            "should not recommend LT cut when capacity is bottleneck"
        );
    }

    #[test]
    fn per_product_lt_targets_when_lt_too_long() {
        let s = scenario_lt_too_long();
        let out = compute_per_product_lt(&s, BayAssignment::BalanceLoad);
        assert!(!out.is_empty(), "expected at least one product LT target");
        let r = &out[0];
        assert_eq!(r.product_id, "p1");
        assert!(r.target_lead_time_days < r.current_lead_time_days);
    }

    #[test]
    fn compute_all_returns_three() {
        let s = scenario_lt_too_long();
        let m = BayAssignment::BalanceLoad;
        let out = run_schedule_mode(&s, m);
        let rec = compute_recommendations(&s, &out, m);
        assert!(rec.bays_needed.is_some());
        assert!(rec.uniform_lt_pct.is_some());
        assert!(!rec.per_product_lt.is_empty());
    }
}

//! Scheduling core (backward windows + forward roll-off backlog).
//!
//! See docs/PLAN.md §4 for the original backward model. Key points:
//! - Demand is exploded into units with due dates (spread mode: even/start/end).
//! - Each unit has a backward window [due - lead_time + 1, due] using the lead
//!   time of the *due date's* quarter for the unit's product.
//! - Multiple strategies are available (see `Strategy` + `benchmark_strategies`).
//!   The production default (`DEFAULT_STRATEGY = RollForwardPriority`) walks the
//!   quarters in order: each quarter, **roll-offs carried over from the previous
//!   quarter get first pick of the bays** (forward, from the earliest free day),
//!   then the quarter's native demand is placed backward (its demanded window
//!   first, else any later start still inside the quarter). A unit only rolls
//!   forward when it can't start at all within the quarter, so a roll-off is the
//!   top priority of the *next* quarter and never languishes to the end of the
//!   schedule. A unit past the horizon is unshippable. Per-quarter misses are
//!   tracked.
//! - Bays across all factories are one global pool (load-balanced first-fit).

use chrono::{Datelike, Duration, NaiveDate};
use std::collections::HashMap;

/// How many quarters past the last demanded quarter a unit may roll forward
/// before it is declared truly unshippable.
const ROLL_HORIZON_QUARTERS: i64 = 8;

/// Linear quarter index for comparison/arithmetic.
fn quarter_index(year: i64, quarter: i64) -> i64 {
    year * 4 + (quarter - 1)
}

/// (year, quarter) of the quarter `n` quarters after the given one.
fn add_quarters(year: i64, quarter: i64, n: i64) -> (i64, i64) {
    let total = quarter_index(year, quarter) + n;
    (total.div_euclid(4), total.rem_euclid(4) + 1)
}

fn next_quarter(year: i64, quarter: i64) -> (i64, i64) {
    add_quarters(year, quarter, 1)
}

// ---------- Public input types (scheduler is decoupled from DB) ----------

#[derive(Debug, Clone)]
pub struct FactoryInput {
    pub id: String,
    pub name: String,
    /// Baseline bay count used for any quarter without an override.
    pub bays: i64,
    /// Idle days required between consecutive jobs on the same bay.
    pub changeover_days: i64,
    /// Per-(year, quarter) overrides. When present, overrides `bays` for that
    /// specific quarter only.
    pub bay_counts_by_quarter: Vec<BayCountInput>,
}

#[derive(Debug, Clone)]
pub struct BayCountInput {
    pub year: i64,
    pub quarter: i64,
    pub bays: i64,
}

#[derive(Debug, Clone)]
pub struct LeadTimeInput {
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

/// Per-(factory, year, quarter) lead-time override for a product. Where present,
/// it replaces the product's base lead time for units built at that factory.
#[derive(Debug, Clone)]
pub struct FactoryLeadTimeInput {
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub lead_time_days: i64,
}

#[derive(Debug, Clone)]
pub struct FactoryAllocationInput {
    pub factory_id: String,
    pub year: i64,
    pub quarter: i64,
    pub allocation_pct: i64,
}

#[derive(Debug, Clone)]
pub struct ProductInput {
    pub id: String,
    pub name: String,
    pub lead_times: Vec<LeadTimeInput>,
    /// Optional per-factory overrides. Empty = same lead time at every factory.
    pub factory_lead_times: Vec<FactoryLeadTimeInput>,
    /// Optional target factory allocation rules. year=0/quarter=0 means global.
    pub factory_allocations: Vec<FactoryAllocationInput>,
}

#[derive(Debug, Clone)]
pub struct DemandInput {
    pub id: String,
    pub product_id: String,
    pub period_type: String, // "month" | "quarter"
    pub year: i64,
    pub period_index: i64,
    pub quantity: i64,
    pub spread_mode: String, // "even" | "start" | "end"
}

#[derive(Debug, Clone)]
pub struct ScheduleInput {
    pub factories: Vec<FactoryInput>,
    pub products: Vec<ProductInput>,
    pub demand: Vec<DemandInput>,
}

/// How bays are chosen when more than one is free for a unit's window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BayAssignment {
    /// Spread demand across factories and bays (least-loaded first). Keeps every
    /// bay lightly used.
    #[default]
    BalanceLoad,
    /// Concentrate work to maximize utilization: still distribute across
    /// factories (least-loaded factory first), but within a factory prefer the
    /// **fullest** bay that fits, so unneeded bays stay completely empty.
    MaximizeUtilization,
}

// ---------- Output types ----------

#[derive(Debug, Clone)]
pub struct ScheduledUnitOut {
    pub demand_id: String,
    pub product_id: String,
    pub factory_id: Option<String>, // None if unshippable
    pub bay_index: Option<i64>,
    pub required_start: NaiveDate,
    /// Actual ship date — the (possibly rolled-forward) due date used to place it.
    pub due_date: NaiveDate,
    /// Originally demanded due date (before any roll-forward).
    pub orig_due_date: NaiveDate,
    pub status: UnitStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitStatus {
    /// Shipped in its originally demanded quarter.
    Shipped,
    /// Shipped, but rolled forward to a later quarter than demanded.
    Late,
    /// Could not ship even after rolling forward to the horizon.
    Unshippable,
}

/// Number of units that failed to ship in a given quarter and were rolled into
/// the next one. Counts each quarter a unit misses (a Q1→Q2→Q3 slip counts in
/// both Q1 and Q2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarterMiss {
    pub year: i64,
    pub quarter: i64,
    pub count: i64,
}

#[derive(Debug, Clone)]
pub struct ScheduleOutput {
    pub units: Vec<ScheduledUnitOut>,
    pub total_demand: usize,
    /// Shipped in the originally demanded quarter.
    pub shipped_on_time: usize,
    /// Shipped, but in a later quarter than demanded.
    pub shipped_late: usize,
    /// Never shipped (rolled past the horizon).
    pub unshippable: usize,
    /// Per-quarter count of units that missed that quarter and rolled forward.
    pub quarter_misses: Vec<QuarterMiss>,
}

impl ScheduleOutput {
    /// Units that did NOT ship in their originally demanded quarter
    /// (= late + unshippable). This is the "shortfall" recommendations target.
    pub fn not_on_time(&self) -> usize {
        self.total_demand - self.shipped_on_time
    }
}

// ---------- Period helpers ----------

/// Quarter index (1..=4) for a given date.
pub fn quarter_of(d: NaiveDate) -> i64 {
    ((d.month0() as i64) / 3) + 1
}

/// First date of the given period.
pub fn period_start(period_type: &str, year: i64, period_index: i64) -> Option<NaiveDate> {
    match period_type {
        "quarter" => {
            let month = match period_index {
                1 => 1,
                2 => 4,
                3 => 7,
                4 => 10,
                _ => return None,
            };
            NaiveDate::from_ymd_opt(year as i32, month, 1)
        }
        "month" => {
            if !(1..=12).contains(&period_index) {
                return None;
            }
            NaiveDate::from_ymd_opt(year as i32, period_index as u32, 1)
        }
        _ => None,
    }
}

/// Last date of the given period (inclusive).
pub fn period_end(period_type: &str, year: i64, period_index: i64) -> Option<NaiveDate> {
    let start = period_start(period_type, year, period_index)?;
    let (next_year, next_month) = match period_type {
        "quarter" => {
            let m = start.month() + 3;
            if m > 12 {
                (start.year() + 1, m - 12)
            } else {
                (start.year(), m)
            }
        }
        "month" => {
            let m = start.month() + 1;
            if m > 12 {
                (start.year() + 1, 1)
            } else {
                (start.year(), m)
            }
        }
        _ => return None,
    };
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1)?;
    Some(next.pred_opt()?)
}

/// Explode an aggregate demand row into per-unit due dates.
pub fn explode_due_dates(d: &DemandInput) -> Vec<NaiveDate> {
    let Some(start) = period_start(&d.period_type, d.year, d.period_index) else {
        return vec![];
    };
    let Some(end) = period_end(&d.period_type, d.year, d.period_index) else {
        return vec![];
    };
    let n = d.quantity.max(0) as usize;
    if n == 0 {
        return vec![];
    }
    let days_span = (end - start).num_days() as i64;

    match d.spread_mode.as_str() {
        "start" => vec![start; n],
        "end" => vec![end; n],
        _ => {
            // "even" — spread quantity across the inclusive period
            if n == 1 {
                // single unit lands at the end of the period (most "expected" due)
                return vec![end];
            }
            // Distribute over [start, end] using fractional positions
            // i in 0..n -> position = (i + 1) / n  (so the last unit lands on end)
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let frac = (i as f64 + 1.0) / (n as f64);
                let offset_days = (frac * (days_span as f64 + 1.0) - 1.0).round() as i64;
                let off = offset_days.clamp(0, days_span);
                let d = start + Duration::days(off);
                out.push(d);
            }
            out
        }
    }
}

// ---------- Serial numbers ----------

/// Generate `n` per-unit serials for a demand row.
///
/// - `"sequence"`: increments the trailing number of `start`, preserving the
///   prefix and zero-padding. e.g. start `"WID-0010"`, n=3 -> WID-0010, WID-0011,
///   WID-0012. If `start` has no trailing digits, units after the first get an
///   index suffix.
/// - `"list"`: takes serials positionally from `list` (one per unit). Missing /
///   blank entries yield `None`.
/// - anything else (`"none"`): all `None`.
pub fn generate_serials(
    mode: &str,
    start: Option<&str>,
    list: &[String],
    n: usize,
) -> Vec<Option<String>> {
    match mode {
        "sequence" => gen_sequence(start.unwrap_or("").trim(), n),
        "list" => (0..n)
            .map(|i| {
                list.get(i)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .collect(),
        _ => vec![None; n],
    }
}

fn gen_sequence(base: &str, n: usize) -> Vec<Option<String>> {
    if base.is_empty() {
        return vec![None; n];
    }
    let bytes = base.as_bytes();
    let mut i = base.len();
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    let prefix = &base[..i];
    let digits = &base[i..];
    if digits.is_empty() {
        // No numeric tail: first unit keeps the base, the rest append an index.
        return (0..n)
            .map(|k| {
                Some(if k == 0 {
                    base.to_string()
                } else {
                    format!("{base}-{k}")
                })
            })
            .collect();
    }
    let width = digits.len();
    let start_num: u128 = digits.parse().unwrap_or(0);
    (0..n)
        .map(|k| {
            Some(format!(
                "{prefix}{:0width$}",
                start_num + k as u128,
                width = width
            ))
        })
        .collect()
}

// ---------- Lead-time lookup ----------

pub struct LtIndex {
    /// product_id -> (year, quarter) -> days
    map: HashMap<String, HashMap<(i64, i64), i64>>,
}

impl LtIndex {
    pub fn new(products: &[ProductInput]) -> Self {
        let mut map: HashMap<String, HashMap<(i64, i64), i64>> = HashMap::new();
        for p in products {
            let mut inner: HashMap<(i64, i64), i64> = HashMap::new();
            for lt in &p.lead_times {
                inner.insert((lt.year, lt.quarter), lt.lead_time_days);
            }
            map.insert(p.id.clone(), inner);
        }
        LtIndex { map }
    }

    /// Lead-time for product on a given due date.
    /// Falls back to (a) latest year/quarter at-or-before, then (b) any defined LT.
    pub fn lookup(&self, product_id: &str, due: NaiveDate) -> Option<i64> {
        let inner = self.map.get(product_id)?;
        let year = due.year() as i64;
        let q = quarter_of(due);
        if let Some(&v) = inner.get(&(year, q)) {
            return Some(v);
        }
        // Fallback: closest defined (year, q) ≤ requested
        let target = (year, q);
        let mut best: Option<((i64, i64), i64)> = None;
        for (&k, &v) in inner.iter() {
            if k <= target {
                if best.map_or(true, |(bk, _)| k > bk) {
                    best = Some((k, v));
                }
            }
        }
        if let Some((_, v)) = best {
            return Some(v);
        }
        // Last resort: any defined LT
        inner.values().next().copied()
    }
}

/// Resolve a (year, quarter) value from a map, falling back to the closest
/// defined quarter at-or-before the target, then to any defined value.
fn lookup_quarterly(inner: &HashMap<(i64, i64), i64>, year: i64, q: i64) -> Option<i64> {
    if let Some(&v) = inner.get(&(year, q)) {
        return Some(v);
    }
    let target = (year, q);
    let mut best: Option<((i64, i64), i64)> = None;
    for (&k, &v) in inner.iter() {
        if k <= target && best.map_or(true, |(bk, _)| k > bk) {
            best = Some((k, v));
        }
    }
    if let Some((_, v)) = best {
        return Some(v);
    }
    inner.values().next().copied()
}

/// Per-(product, factory) lead-time overrides. Mirrors `LtIndex`'s fallback
/// semantics (closest defined quarter at-or-before, then any). Returns `None`
/// when the product has no override at that factory at all, so the caller can
/// fall back to the base product lead time.
pub struct FactoryLtIndex {
    /// (product_id, factory_id) -> (year, quarter) -> days
    map: HashMap<(String, String), HashMap<(i64, i64), i64>>,
}

impl FactoryLtIndex {
    pub fn new(products: &[ProductInput]) -> Self {
        let mut map: HashMap<(String, String), HashMap<(i64, i64), i64>> = HashMap::new();
        for p in products {
            for lt in &p.factory_lead_times {
                map.entry((p.id.clone(), lt.factory_id.clone()))
                    .or_default()
                    .insert((lt.year, lt.quarter), lt.lead_time_days);
            }
        }
        FactoryLtIndex { map }
    }

    /// Override lead-time for the product at the given factory on a due date.
    pub fn lookup(&self, product_id: &str, factory_id: &str, due: NaiveDate) -> Option<i64> {
        let inner = self
            .map
            .get(&(product_id.to_string(), factory_id.to_string()))?;
        lookup_quarterly(inner, due.year() as i64, quarter_of(due))
    }
}

#[derive(Debug, Clone)]
pub struct AllocationRule {
    factory_id: String,
    allocation_pct: i64,
}

pub struct AllocationIndex {
    /// product_id -> (year, quarter) -> rule. (0, 0) is the global/default rule.
    map: HashMap<String, HashMap<(i64, i64), AllocationRule>>,
}

impl AllocationIndex {
    pub fn new(products: &[ProductInput]) -> Self {
        let mut map: HashMap<String, HashMap<(i64, i64), AllocationRule>> = HashMap::new();
        for p in products {
            for a in &p.factory_allocations {
                map.entry(p.id.clone()).or_default().insert(
                    (a.year, a.quarter),
                    AllocationRule {
                        factory_id: a.factory_id.clone(),
                        allocation_pct: a.allocation_pct.clamp(0, 100),
                    },
                );
            }
        }
        AllocationIndex { map }
    }

    pub fn lookup(&self, product_id: &str, due: NaiveDate) -> Option<&AllocationRule> {
        let inner = self.map.get(product_id)?;
        let key = (due.year() as i64, quarter_of(due));
        inner.get(&key).or_else(|| inner.get(&(0, 0)))
    }
}

// ---------- Bay-count lookup (per (factory, quarter)) ----------

/// Effective bay count per (factory, quarter), backed by a baseline.
#[derive(Debug, Clone)]
pub struct BayCountIndex {
    /// factory_id -> baseline bays
    baseline: HashMap<String, i64>,
    /// factory_id -> (year, quarter) -> bays
    overrides: HashMap<String, HashMap<(i64, i64), i64>>,
}

impl BayCountIndex {
    pub fn new(factories: &[FactoryInput]) -> Self {
        let mut baseline: HashMap<String, i64> = HashMap::new();
        let mut overrides: HashMap<String, HashMap<(i64, i64), i64>> = HashMap::new();
        for f in factories {
            baseline.insert(f.id.clone(), f.bays.max(0));
            let mut o: HashMap<(i64, i64), i64> = HashMap::new();
            for bc in &f.bay_counts_by_quarter {
                if (1..=4).contains(&bc.quarter) {
                    o.insert((bc.year, bc.quarter), bc.bays.max(0));
                }
            }
            if !o.is_empty() {
                overrides.insert(f.id.clone(), o);
            }
        }
        BayCountIndex {
            baseline,
            overrides,
        }
    }

    /// Effective bay count for the factory in the given quarter. Override wins
    /// over baseline; missing factory returns 0.
    pub fn effective(&self, factory_id: &str, year: i64, quarter: i64) -> i64 {
        if let Some(o) = self.overrides.get(factory_id) {
            if let Some(&v) = o.get(&(year, quarter)) {
                return v;
            }
        }
        self.baseline.get(factory_id).copied().unwrap_or(0)
    }

    /// Maximum effective bay count across baseline and all defined overrides.
    /// Used to size the bay pool so every quarter's needs can be represented.
    pub fn max_for(&self, factory_id: &str) -> i64 {
        let base = self.baseline.get(factory_id).copied().unwrap_or(0);
        let omax = self
            .overrides
            .get(factory_id)
            .and_then(|m| m.values().copied().max())
            .unwrap_or(0);
        base.max(omax)
    }

    /// Minimum effective bay count across every quarter touched by [start, end].
    /// A bay slot with index `i` may be used only if `i < this value`.
    pub fn min_in_window(&self, factory_id: &str, start: NaiveDate, end: NaiveDate) -> i64 {
        debug_assert!(start <= end);
        let mut quarters: Vec<(i64, i64)> = Vec::new();
        let mut d = start;
        loop {
            let key = (d.year() as i64, quarter_of(d));
            if quarters.last() != Some(&key) {
                quarters.push(key);
            }
            // Jump to the first day of the next month to walk forward cheaply
            let nm_year = if d.month() == 12 {
                d.year() + 1
            } else {
                d.year()
            };
            let nm_month = if d.month() == 12 { 1 } else { d.month() + 1 };
            let next = match NaiveDate::from_ymd_opt(nm_year, nm_month, 1) {
                Some(v) => v,
                None => break,
            };
            if next > end {
                // capture end's quarter if not yet added
                let key_end = (end.year() as i64, quarter_of(end));
                if quarters.last() != Some(&key_end) {
                    quarters.push(key_end);
                }
                break;
            }
            d = next;
        }
        quarters
            .into_iter()
            .map(|(y, q)| self.effective(factory_id, y, q))
            .min()
            .unwrap_or(0)
    }
}

// ---------- Bay pool ----------

/// A single bay tracks its reserved intervals (sorted, non-overlapping).
#[derive(Debug, Default, Clone)]
pub struct Bay {
    /// Sorted by start. Each interval is [start, end] inclusive.
    intervals: Vec<(NaiveDate, NaiveDate)>,
    /// Cached running total of reserved days across intervals (for load-balancing).
    reserved_days: i64,
}

impl Bay {
    /// Is [start, end] free? (inclusive endpoints)
    pub fn is_free(&self, start: NaiveDate, end: NaiveDate, changeover_days: i64) -> bool {
        let gap = changeover_days.max(0);
        for (s, e) in &self.intervals {
            let blocked_start = *s - chrono::Duration::days(gap);
            let blocked_end = *e + chrono::Duration::days(gap);
            if blocked_start <= end && blocked_end >= start {
                return false;
            }
        }
        true
    }

    pub fn reserve(&mut self, start: NaiveDate, end: NaiveDate) {
        let pos = self
            .intervals
            .binary_search_by(|(s, _)| s.cmp(&start))
            .unwrap_or_else(|p| p);
        self.intervals.insert(pos, (start, end));
        self.reserved_days += (end - start).num_days() + 1;
    }

    /// Total reserved bay-days. Used for load-balanced placement.
    pub fn reserved_days(&self) -> i64 {
        self.reserved_days
    }

    /// Smallest gap (in days) between the free window `[start, end]` and the
    /// nearest reserved interval on either side. `None` if the bay has no
    /// reservations at all (i.e. placing here opens a fresh bay). A value of 0
    /// means the new window butts right up against existing work. Assumes
    /// `[start, end]` does not overlap any interval. Used by utilization-packing
    /// to prefer the bay that leaves the least idle.
    pub fn nearest_gap(&self, start: NaiveDate, end: NaiveDate) -> Option<i64> {
        let mut best: Option<i64> = None;
        for (s, e) in &self.intervals {
            let gap = if *e < start {
                (start - *e).num_days() - 1
            } else if *s > end {
                (*s - end).num_days() - 1
            } else {
                0
            };
            best = Some(best.map_or(gap, |b| b.min(gap)));
        }
        best
    }

    /// End dates of all reserved intervals.
    pub fn interval_ends(&self) -> impl Iterator<Item = NaiveDate> + '_ {
        self.intervals.iter().map(|&(_, e)| e)
    }
}

#[derive(Debug, Clone)]
pub struct PoolBay {
    pub factory_id: String,
    pub factory_name: String,
    pub changeover_days: i64,
    pub bay_index: i64, // 0-based within factory
    pub bay: Bay,
}

#[derive(Debug, Clone)]
pub struct BayPool {
    pub bays: Vec<PoolBay>,
    bay_counts: BayCountIndex,
    assignment: BayAssignment,
}

impl BayPool {
    pub fn from_factories(factories: &[FactoryInput]) -> Self {
        Self::from_factories_with(factories, BayAssignment::default())
    }

    pub fn from_factories_with(factories: &[FactoryInput], assignment: BayAssignment) -> Self {
        let bay_counts = BayCountIndex::new(factories);
        let mut bays = Vec::new();
        for f in factories {
            // Pool size = max over baseline and any per-quarter override, so the
            // bay slot exists when it might be needed. Slots are gated by the
            // per-window effective count in `find_free`.
            let max_bays = bay_counts.max_for(&f.id).max(f.bays.max(0));
            for i in 0..max_bays {
                bays.push(PoolBay {
                    factory_id: f.id.clone(),
                    factory_name: f.name.clone(),
                    changeover_days: f.changeover_days.max(0),
                    bay_index: i,
                    bay: Bay::default(),
                });
            }
        }
        BayPool {
            bays,
            bay_counts,
            assignment,
        }
    }

    /// Per-bay ranking key for a candidate window `[start, finish]`. Lower sorts
    /// first (= chosen). The factory dimension always balances (least-loaded
    /// factory first) so work distributes across factories; the bay dimension
    /// depends on the assignment mode:
    ///   - BalanceLoad: prefer the **emptiest** bay (spread within a factory).
    ///   - MaximizeUtilization: prefer the bay that leaves the **smallest gap**
    ///     (reuse an already-used bay, tightest fit first). Empty bays rank last
    ///     (gap = i64::MAX) so units pack into the fewest bays, leaving the rest
    ///     completely empty.
    fn bay_rank(
        &self,
        bay: &Bay,
        factory_load: i64,
        start: NaiveDate,
        finish: NaiveDate,
        idx: usize,
    ) -> (i64, i64, usize) {
        let bay_key = match self.assignment {
            BayAssignment::BalanceLoad => bay.reserved_days(),
            BayAssignment::MaximizeUtilization => {
                bay.nearest_gap(start, finish).unwrap_or(i64::MAX)
            }
        };
        (factory_load, bay_key, idx)
    }

    pub fn bay_counts(&self) -> &BayCountIndex {
        &self.bay_counts
    }

    /// Find the **least-loaded** bay free in [start, end]. Returns index into
    /// `bays`. This spreads demand across factories and across bays within a
    /// factory, rather than always piling on the first bay.
    ///
    /// Slots are also filtered to those that exist for the entire window —
    /// i.e. `bay_index < bay_counts.min_in_window(factory, start, end)`. This
    /// is what lets the bay count vary by quarter.
    ///
    /// Ranking is:
    ///   1. lowest per-factory total reserved days  (split across factories)
    ///   2. lowest per-bay reserved days            (split within a factory)
    ///   3. lowest pool index                       (deterministic tiebreak)
    pub fn find_free(&self, start: NaiveDate, end: NaiveDate) -> Option<usize> {
        self.find_free_where(start, end, |_| true)
    }

    pub fn find_free_where<A>(&self, start: NaiveDate, end: NaiveDate, allowed: A) -> Option<usize>
    where
        A: Fn(&str) -> bool,
    {
        // Cache the per-window factory cap so we compute it once per factory.
        let mut window_cap: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();

        // Precompute total load per factory once per call.
        let mut factory_load: std::collections::HashMap<&str, i64> =
            std::collections::HashMap::new();
        for b in &self.bays {
            *factory_load.entry(b.factory_id.as_str()).or_insert(0) += b.bay.reserved_days();
        }

        let mut best: Option<(i64, i64, usize)> = None; // (factory_load, bay_load, idx)
        for (i, b) in self.bays.iter().enumerate() {
            if !allowed(&b.factory_id) {
                continue;
            }
            // Per-window bay-count gate
            let cap = *window_cap
                .entry(b.factory_id.as_str())
                .or_insert_with(|| self.bay_counts.min_in_window(&b.factory_id, start, end));
            if b.bay_index >= cap {
                continue;
            }
            if !b.bay.is_free(start, end, b.changeover_days) {
                continue;
            }
            let fl = factory_load
                .get(b.factory_id.as_str())
                .copied()
                .unwrap_or(0);
            let key = self.bay_rank(&b.bay, fl, start, end, i);
            match best {
                None => best = Some(key),
                Some(cur) if key < cur => best = Some(key),
                _ => {}
            }
        }
        best.map(|(_, _, i)| i)
    }

    /// Like `find_free`, but the occupied window may differ per factory.
    /// `window(factory_id)` returns the `(start, finish)` the unit would occupy
    /// if built at that factory — this is what makes per-factory lead times work
    /// while preserving load-balanced placement. A bay is eligible only if its
    /// per-window effective bay-count gate passes and the interval is free.
    /// Ranking matches `find_free` (least-loaded factory, then least-loaded bay,
    /// then pool index). Returns `(start, finish, pool_index)` of the chosen bay.
    pub fn find_free_window<W>(&self, window: W) -> Option<(NaiveDate, NaiveDate, usize)>
    where
        W: Fn(&str) -> (NaiveDate, NaiveDate),
    {
        self.find_free_window_where(window, |_| true)
    }

    pub fn find_free_window_where<W, A>(
        &self,
        window: W,
        allowed: A,
    ) -> Option<(NaiveDate, NaiveDate, usize)>
    where
        W: Fn(&str) -> (NaiveDate, NaiveDate),
        A: Fn(&str) -> bool,
    {
        let mut win_cache: std::collections::HashMap<&str, (NaiveDate, NaiveDate)> =
            std::collections::HashMap::new();
        let mut window_cap: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();

        let mut factory_load: std::collections::HashMap<&str, i64> =
            std::collections::HashMap::new();
        for b in &self.bays {
            *factory_load.entry(b.factory_id.as_str()).or_insert(0) += b.bay.reserved_days();
        }

        // (rank_key, idx, start, finish)
        let mut best: Option<((i64, i64, usize), NaiveDate, NaiveDate)> = None;
        for (i, b) in self.bays.iter().enumerate() {
            let fid = b.factory_id.as_str();
            if !allowed(fid) {
                continue;
            }
            let (start, finish) = *win_cache.entry(fid).or_insert_with(|| window(fid));
            let cap = *window_cap
                .entry(fid)
                .or_insert_with(|| self.bay_counts.min_in_window(fid, start, finish));
            if b.bay_index >= cap {
                continue;
            }
            if !b.bay.is_free(start, finish, b.changeover_days) {
                continue;
            }
            let fl = factory_load.get(fid).copied().unwrap_or(0);
            let key = self.bay_rank(&b.bay, fl, start, finish, i);
            match best {
                None => best = Some((key, start, finish)),
                Some((cur, _, _)) if key < cur => best = Some((key, start, finish)),
                _ => {}
            }
        }
        best.map(|((_, _, i), s, f)| (s, f, i))
    }

    pub fn reserve(&mut self, idx: usize, start: NaiveDate, end: NaiveDate) {
        self.bays[idx].bay.reserve(start, end);
    }

    /// Candidate start dates (>= `release`) at which bay availability can change:
    /// the day after each currently-reserved interval ends. Used to find the
    /// earliest feasible window for a unit without scanning day-by-day.
    pub fn reservation_end_candidates(&self, release: NaiveDate) -> Vec<NaiveDate> {
        let mut v = Vec::new();
        for pb in &self.bays {
            for end in pb.bay.interval_ends() {
                let c = end + Duration::days(1);
                if c >= release {
                    v.push(c);
                }
            }
        }
        v
    }
}

// ---------- Run ----------

/// Run the backward-scheduling algorithm (load-balanced bay assignment).
/// Convenience wrapper used widely by tests.
#[allow(dead_code)]
pub fn run_schedule(input: &ScheduleInput) -> ScheduleOutput {
    run_schedule_mode(input, BayAssignment::default())
}

/// Run scheduling with a chosen bay-assignment mode.
pub fn run_schedule_mode(input: &ScheduleInput, mode: BayAssignment) -> ScheduleOutput {
    run_schedule_with_lt_mode(input, |_pid, lt| lt, mode)
}

/// Run scheduling with an optional per-product lead-time transformation
/// (load-balanced). Convenience wrapper kept for completeness.
#[allow(dead_code)]
pub fn run_schedule_with_lt<F>(input: &ScheduleInput, lt_transform: F) -> ScheduleOutput
where
    F: FnMut(&str, i64) -> i64,
{
    run_schedule_with_lt_mode(input, lt_transform, BayAssignment::default())
}

/// As `run_schedule_with_lt`, but with a chosen bay-assignment mode.
pub fn run_schedule_with_lt_mode<F>(
    input: &ScheduleInput,
    lt_transform: F,
    mode: BayAssignment,
) -> ScheduleOutput
where
    F: FnMut(&str, i64) -> i64,
{
    run_with(input, lt_transform, DEFAULT_STRATEGY, mode)
}

/// Run a specific scheduling strategy (identity lead times). Used by the
/// strategy benchmark; kept public so alternative strategies can be compared.
#[allow(dead_code)]
pub fn run_schedule_strategy(input: &ScheduleInput, strategy: Strategy) -> ScheduleOutput {
    run_with(input, |_pid, lt| lt, strategy, BayAssignment::default())
}

/// Available scheduling strategies. See `benchmark_strategies` for the comparison
/// that informs `DEFAULT_STRATEGY`. Variants other than the default are exercised
/// by the benchmark.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// Pure backward greedy: place each unit at its exact demanded window if a
    /// bay is free, else unshippable (no roll-forward). The on-time ceiling.
    BackwardGreedy,
    /// FIFO forward: process by demanded due date, ship as early as a bay frees.
    /// Backlog (older demand) takes the first free slots in later quarters,
    /// before that quarter's own demand.
    FifoAsap,
    /// Backward-first, then forward roll-offs: place every unit that fits its
    /// exact window (maximise on-time), then ship the leftovers ASAP (FIFO).
    BackwardThenForward,
    /// Quarter-by-quarter backward with carryover: each quarter schedules its
    /// carried-over backlog (oldest first) then its native demand, backward;
    /// whatever doesn't fit carries into the next quarter.
    QuarterCarryover,
    /// Quarter-by-quarter with **roll-off priority**: each quarter the carried-
    /// over backlog is placed FIRST (forward, from the earliest free bay in the
    /// quarter), then this quarter's native demand (backward window first, then
    /// any later start within the quarter). A unit only rolls forward if it
    /// can't start at all within the quarter — so a roll-off is the top priority
    /// of the very next quarter and never languishes to the end of the schedule.
    RollForwardPriority,
}

/// The production strategy, chosen by `benchmark_strategies`.
pub const DEFAULT_STRATEGY: Strategy = Strategy::RollForwardPriority;

#[derive(Clone)]
struct Unit {
    demand_id: String,
    product_id: String,
    orig_due: NaiveDate,
    orig_q: (i64, i64),
    /// Base lead time (product matrix, transformed). Used to seed candidate
    /// windows and as the fallback when a factory has no override.
    lt: i64,
    release: NaiveDate,
    /// Per-factory lead time (already transformed). Missing factory => `lt`.
    factory_lt: HashMap<String, i64>,
    /// Factory ids this unit is allowed to use. Empty means all factories.
    eligible_factories: Vec<String>,
}

impl Unit {
    /// Lead time if this unit is built at `factory_id` (override or base).
    fn lt_for(&self, factory_id: &str) -> i64 {
        self.factory_lt.get(factory_id).copied().unwrap_or(self.lt)
    }

    fn can_use_factory(&self, factory_id: &str) -> bool {
        self.eligible_factories.is_empty()
            || self.eligible_factories.iter().any(|f| f == factory_id)
    }
}

#[derive(Clone)]
struct Placement {
    start: NaiveDate,
    finish: NaiveDate,
    factory_id: String,
    bay_index: i64,
}

fn run_with<F>(
    input: &ScheduleInput,
    mut lt_transform: F,
    strategy: Strategy,
    mode: BayAssignment,
) -> ScheduleOutput
where
    F: FnMut(&str, i64) -> i64,
{
    let lt_index = LtIndex::new(&input.products);
    let fac_lt_index = FactoryLtIndex::new(&input.products);
    let alloc_index = AllocationIndex::new(&input.products);
    let all_factory_ids: Vec<String> = input.factories.iter().map(|f| f.id.clone()).collect();
    let mut units: Vec<Unit> = Vec::new();
    let mut latest_q: Option<(i64, i64)> = None;
    for d in &input.demand {
        let due_dates = explode_due_dates(d);
        let alloc_target_count = due_dates
            .first()
            .and_then(|due| alloc_index.lookup(&d.product_id, *due))
            .map(|rule| ((due_dates.len() as i64 * rule.allocation_pct) + 50) / 100)
            .unwrap_or(0) as usize;
        for (unit_idx, due) in due_dates.into_iter().enumerate() {
            let raw_lt = lt_index.lookup(&d.product_id, due).unwrap_or(0);
            let lt = lt_transform(&d.product_id, raw_lt).max(1);
            // Resolve a per-factory lead time: a factory override (transformed)
            // where defined, else the base lead time. Lead-time quarter follows
            // the originally demanded due date (matching the base behavior).
            let mut factory_lt: HashMap<String, i64> = HashMap::new();
            for f in &input.factories {
                if let Some(raw) = fac_lt_index.lookup(&d.product_id, &f.id, due) {
                    factory_lt.insert(f.id.clone(), lt_transform(&d.product_id, raw).max(1));
                }
            }
            let q = (due.year() as i64, quarter_of(due));
            let eligible_factories = alloc_index
                .lookup(&d.product_id, due)
                .map(|rule| {
                    if unit_idx < alloc_target_count {
                        vec![rule.factory_id.clone()]
                    } else {
                        let others: Vec<String> = all_factory_ids
                            .iter()
                            .filter(|fid| *fid != &rule.factory_id)
                            .cloned()
                            .collect();
                        if others.is_empty() {
                            vec![rule.factory_id.clone()]
                        } else {
                            others
                        }
                    }
                })
                .unwrap_or_default();
            latest_q = Some(match latest_q {
                Some(cur) if quarter_index(cur.0, cur.1) >= quarter_index(q.0, q.1) => cur,
                _ => q,
            });
            units.push(Unit {
                demand_id: d.id.clone(),
                product_id: d.product_id.clone(),
                orig_due: due,
                orig_q: q,
                lt,
                release: due - Duration::days(lt - 1),
                factory_lt,
                eligible_factories,
            });
        }
    }

    let horizon_q = latest_q.map(|(y, q)| add_quarters(y, q, ROLL_HORIZON_QUARTERS));
    let horizon_end = horizon_q.map(|(hy, hq)| period_end("quarter", hy, hq).expect("valid q"));

    let mut pool = BayPool::from_factories_with(&input.factories, mode);
    let placements = match strategy {
        Strategy::BackwardGreedy => strat_backward_greedy(&mut pool, &units),
        Strategy::FifoAsap => strat_fifo_asap(&mut pool, &units, horizon_q, horizon_end),
        Strategy::BackwardThenForward => {
            strat_backward_then_forward(&mut pool, &units, horizon_q, horizon_end)
        }
        Strategy::QuarterCarryover => strat_quarter_carryover(&mut pool, &units, horizon_q),
        Strategy::RollForwardPriority => strat_rollforward_priority(&mut pool, &units, horizon_q),
    };

    finalize(&units, placements, horizon_q)
}

// --- placement primitives (read-only; caller reserves) ---

/// Exact backward window [release, due].
fn place_exact(pool: &BayPool, u: &Unit) -> Option<(NaiveDate, NaiveDate, usize)> {
    pool.find_free_window_where(
        |fid| {
            let finish = u.orig_due;
            (finish - Duration::days(u.lt_for(fid) - 1), finish)
        },
        |fid| u.can_use_factory(fid),
    )
}

/// Earliest feasible window at/after `release` (ship ASAP), within the horizon.
fn place_asap(
    pool: &BayPool,
    u: &Unit,
    horizon_q: Option<(i64, i64)>,
    horizon_end: Option<NaiveDate>,
) -> Option<(NaiveDate, NaiveDate, usize)> {
    // Availability only changes at: release, the day after each existing
    // reservation ends, and each quarter boundary (variable bay counts).
    let mut cands = vec![u.release];
    cands.extend(pool.reservation_end_candidates(u.release));
    if let (Some(hend), Some(hq)) = (horizon_end, horizon_q) {
        let mut q = u.orig_q;
        loop {
            if let Some(qs) = period_start("quarter", q.0, q.1) {
                if qs >= u.release && qs <= hend {
                    cands.push(qs);
                }
            }
            if quarter_index(q.0, q.1) >= quarter_index(hq.0, hq.1) {
                break;
            }
            q = next_quarter(q.0, q.1);
        }
    }
    cands.sort();
    cands.dedup();
    for c in cands {
        if let Some((s, f, b)) = pool.find_free_window_where(
            |fid| (c, c + Duration::days(u.lt_for(fid) - 1)),
            |fid| u.can_use_factory(fid),
        ) {
            if let Some(hend) = horizon_end {
                if f > hend {
                    continue;
                }
            }
            return Some((s, f, b));
        }
    }
    None
}

fn reserve_placement(
    pool: &mut BayPool,
    b: usize,
    start: NaiveDate,
    finish: NaiveDate,
) -> Placement {
    let (factory_id, bay_index) = {
        let pb = &pool.bays[b];
        (pb.factory_id.clone(), pb.bay_index)
    };
    pool.reserve(b, start, finish);
    Placement {
        start,
        finish,
        factory_id,
        bay_index,
    }
}

fn order_by<K: Ord, G: Fn(&Unit) -> K>(units: &[Unit], key: G) -> Vec<usize> {
    let mut o: Vec<usize> = (0..units.len()).collect();
    o.sort_by(|&a, &b| {
        key(&units[a])
            .cmp(&key(&units[b]))
            .then_with(|| units[a].product_id.cmp(&units[b].product_id))
    });
    o
}

// --- strategies (each returns a placement per unit index) ---

fn strat_backward_greedy(pool: &mut BayPool, units: &[Unit]) -> Vec<Option<Placement>> {
    let mut res = vec![None; units.len()];
    for i in order_by(units, |u| u.release) {
        if let Some((s, f, b)) = place_exact(pool, &units[i]) {
            res[i] = Some(reserve_placement(pool, b, s, f));
        }
    }
    res
}

fn strat_fifo_asap(
    pool: &mut BayPool,
    units: &[Unit],
    horizon_q: Option<(i64, i64)>,
    horizon_end: Option<NaiveDate>,
) -> Vec<Option<Placement>> {
    let mut res = vec![None; units.len()];
    for i in order_by(units, |u| u.orig_due) {
        if let Some((s, f, b)) = place_asap(pool, &units[i], horizon_q, horizon_end) {
            res[i] = Some(reserve_placement(pool, b, s, f));
        }
    }
    res
}

fn strat_backward_then_forward(
    pool: &mut BayPool,
    units: &[Unit],
    horizon_q: Option<(i64, i64)>,
    horizon_end: Option<NaiveDate>,
) -> Vec<Option<Placement>> {
    let mut res = vec![None; units.len()];
    // Pass 1 (backward): place everything that fits its exact demanded window.
    let mut leftovers = Vec::new();
    for i in order_by(units, |u| u.release) {
        if let Some((s, f, b)) = place_exact(pool, &units[i]) {
            res[i] = Some(reserve_placement(pool, b, s, f));
        } else {
            leftovers.push(i);
        }
    }
    // Pass 2 (forward): ship the roll-offs as early as possible, FIFO by due date.
    leftovers.sort_by(|&a, &b| {
        units[a]
            .orig_due
            .cmp(&units[b].orig_due)
            .then_with(|| units[a].product_id.cmp(&units[b].product_id))
    });
    for i in leftovers {
        if let Some((s, f, b)) = place_asap(pool, &units[i], horizon_q, horizon_end) {
            res[i] = Some(reserve_placement(pool, b, s, f));
        }
    }
    res
}

fn strat_quarter_carryover(
    pool: &mut BayPool,
    units: &[Unit],
    horizon_q: Option<(i64, i64)>,
) -> Vec<Option<Placement>> {
    let mut res = vec![None; units.len()];
    if units.is_empty() {
        return res;
    }
    let mut native: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut first_qi = i64::MAX;
    for (i, u) in units.iter().enumerate() {
        let qi = quarter_index(u.orig_q.0, u.orig_q.1);
        native.entry(qi).or_default().push(i);
        first_qi = first_qi.min(qi);
    }
    let horizon_qi = horizon_q
        .map(|(y, q)| quarter_index(y, q))
        .unwrap_or(first_qi);

    let mut carryover: Vec<usize> = Vec::new();
    let mut qi = first_qi;
    while qi <= horizon_qi {
        let (qy, qq) = (qi.div_euclid(4), qi.rem_euclid(4) + 1);
        let qend = period_end("quarter", qy, qq).expect("valid q");
        // Carried-over backlog first (oldest), then this quarter's native demand.
        let mut batch = carryover.clone();
        if let Some(mut nat) = native.remove(&qi) {
            nat.sort_by(|&a, &b| {
                units[a]
                    .orig_due
                    .cmp(&units[b].orig_due)
                    .then_with(|| units[a].product_id.cmp(&units[b].product_id))
            });
            batch.extend(nat);
        }
        carryover.clear();
        for i in batch {
            let u = &units[i];
            // Native keeps its demanded due date; a rolled unit is now due by the
            // end of this quarter and is backward-scheduled from there.
            let due = if quarter_index(u.orig_q.0, u.orig_q.1) == qi {
                u.orig_due
            } else {
                qend
            };
            let start = due - Duration::days(u.lt - 1);
            if let Some(b) = pool.find_free_where(start, due, |fid| u.can_use_factory(fid)) {
                res[i] = Some(reserve_placement(pool, b, start, due));
            } else {
                carryover.push(i);
            }
        }
        qi += 1;
    }
    res
}

/// Earliest feasible window whose START is in `[earliest, latest_start]`.
/// (The finish may spill past `latest_start`; the ship quarter follows from it.)
///
/// Factory-aware: at each candidate start the occupied window's length depends
/// on the factory's lead time for this unit, so the finish is computed per
/// factory inside `find_free_window`. The least-loaded eligible bay wins
/// (load-balanced placement is preserved).
fn place_asap_start_in(
    pool: &BayPool,
    u: &Unit,
    earliest: NaiveDate,
    latest_start: NaiveDate,
) -> Option<(NaiveDate, NaiveDate, usize)> {
    if earliest > latest_start {
        return None;
    }
    let mut cands = vec![earliest];
    for c in pool.reservation_end_candidates(earliest) {
        if c <= latest_start {
            cands.push(c);
        }
    }
    // Quarter boundaries in range (variable bay counts can increase there).
    let mut q = (earliest.year() as i64, quarter_of(earliest));
    loop {
        if let Some(qs) = period_start("quarter", q.0, q.1) {
            if qs >= earliest && qs <= latest_start {
                cands.push(qs);
            }
        }
        if quarter_index(q.0, q.1)
            >= quarter_index(latest_start.year() as i64, quarter_of(latest_start))
        {
            break;
        }
        q = next_quarter(q.0, q.1);
    }
    cands.sort();
    cands.dedup();
    for c in cands {
        if c > latest_start {
            break;
        }
        if let Some((s, f, b)) = pool.find_free_window_where(
            |fid| (c, c + Duration::days(u.lt_for(fid) - 1)),
            |fid| u.can_use_factory(fid),
        ) {
            return Some((s, f, b));
        }
    }
    None
}

fn strat_rollforward_priority(
    pool: &mut BayPool,
    units: &[Unit],
    horizon_q: Option<(i64, i64)>,
) -> Vec<Option<Placement>> {
    let mut res = vec![None; units.len()];
    if units.is_empty() {
        return res;
    }
    let mut native: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut first_qi = i64::MAX;
    for (i, u) in units.iter().enumerate() {
        let qi = quarter_index(u.orig_q.0, u.orig_q.1);
        native.entry(qi).or_default().push(i);
        first_qi = first_qi.min(qi);
    }
    let horizon_qi = horizon_q
        .map(|(y, q)| quarter_index(y, q))
        .unwrap_or(first_qi);

    let mut carryover: Vec<usize> = Vec::new();
    let mut qi = first_qi;
    while qi <= horizon_qi {
        let (qy, qq) = (qi.div_euclid(4), qi.rem_euclid(4) + 1);
        let q_start = period_start("quarter", qy, qq).expect("valid q");
        let q_end = period_end("quarter", qy, qq).expect("valid q");

        let mut new_carry: Vec<usize> = Vec::new();

        // 1) Carried-over roll-offs get FIRST pick of this quarter's bays
        //    (forward, from the earliest free day on/after the quarter start).
        let mut carry = std::mem::take(&mut carryover);
        carry.sort_by(|&a, &b| {
            units[a]
                .orig_due
                .cmp(&units[b].orig_due)
                .then_with(|| units[a].product_id.cmp(&units[b].product_id))
        });
        for i in carry {
            match place_asap_start_in(pool, &units[i], q_start, q_end) {
                Some((s, f, b)) => res[i] = Some(reserve_placement(pool, b, s, f)),
                None => new_carry.push(i), // quarter full — roll, stay top priority next q
            }
        }

        // 2) Then this quarter's native demand: its exact backward window first,
        //    otherwise any later start still within the quarter. If it can't
        //    start at all this quarter, it rolls forward.
        if let Some(mut nat) = native.remove(&qi) {
            nat.sort_by(|&a, &b| {
                units[a]
                    .release
                    .cmp(&units[b].release)
                    .then_with(|| units[a].product_id.cmp(&units[b].product_id))
            });
            for i in nat {
                match place_asap_start_in(pool, &units[i], units[i].release, q_end) {
                    Some((s, f, b)) => res[i] = Some(reserve_placement(pool, b, s, f)),
                    None => new_carry.push(i),
                }
            }
        }

        carryover = new_carry;
        qi += 1;
    }
    res
}

fn finalize(
    units: &[Unit],
    placements: Vec<Option<Placement>>,
    horizon_q: Option<(i64, i64)>,
) -> ScheduleOutput {
    let mut out_units: Vec<ScheduledUnitOut> = Vec::with_capacity(units.len());
    let mut misses: HashMap<(i64, i64), i64> = HashMap::new();
    let mut shipped_on_time = 0usize;
    let mut shipped_late = 0usize;
    let mut unshippable = 0usize;

    for (i, u) in units.iter().enumerate() {
        match &placements[i] {
            Some(p) => {
                let ship_q = (p.finish.year() as i64, quarter_of(p.finish));
                let on_time = ship_q == u.orig_q;
                if on_time {
                    shipped_on_time += 1;
                } else {
                    shipped_late += 1;
                }
                record_misses(&mut misses, u.orig_q, ship_q);
                out_units.push(ScheduledUnitOut {
                    demand_id: u.demand_id.clone(),
                    product_id: u.product_id.clone(),
                    factory_id: Some(p.factory_id.clone()),
                    bay_index: Some(p.bay_index),
                    required_start: p.start,
                    due_date: p.finish,
                    orig_due_date: u.orig_due,
                    status: if on_time {
                        UnitStatus::Shipped
                    } else {
                        UnitStatus::Late
                    },
                });
            }
            None => {
                unshippable += 1;
                if let Some((hy, hq)) = horizon_q {
                    record_misses(&mut misses, u.orig_q, next_quarter(hy, hq));
                }
                out_units.push(ScheduledUnitOut {
                    demand_id: u.demand_id.clone(),
                    product_id: u.product_id.clone(),
                    factory_id: None,
                    bay_index: None,
                    required_start: u.release,
                    due_date: u.orig_due,
                    orig_due_date: u.orig_due,
                    status: UnitStatus::Unshippable,
                });
            }
        }
    }

    let mut quarter_misses: Vec<QuarterMiss> = misses
        .into_iter()
        .map(|((year, quarter), count)| QuarterMiss {
            year,
            quarter,
            count,
        })
        .collect();
    quarter_misses.sort_by_key(|m| (m.year, m.quarter));

    ScheduleOutput {
        total_demand: out_units.len(),
        shipped_on_time,
        shipped_late,
        unshippable,
        quarter_misses,
        units: out_units,
    }
}

/// Record one miss for every quarter in `[from_q, end_excl)`.
fn record_misses(misses: &mut HashMap<(i64, i64), i64>, from_q: (i64, i64), end_excl: (i64, i64)) {
    let mut q = from_q;
    while quarter_index(q.0, q.1) < quarter_index(end_excl.0, end_excl.1) {
        *misses.entry(q).or_insert(0) += 1;
        q = next_quarter(q.0, q.1);
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn quarter_lookup() {
        assert_eq!(quarter_of(ymd(2026, 1, 1)), 1);
        assert_eq!(quarter_of(ymd(2026, 3, 31)), 1);
        assert_eq!(quarter_of(ymd(2026, 4, 1)), 2);
        assert_eq!(quarter_of(ymd(2026, 12, 31)), 4);
    }

    #[test]
    fn period_bounds() {
        assert_eq!(period_start("quarter", 2026, 3), Some(ymd(2026, 7, 1)));
        assert_eq!(period_end("quarter", 2026, 3), Some(ymd(2026, 9, 30)));
        assert_eq!(period_start("month", 2026, 2), Some(ymd(2026, 2, 1)));
        assert_eq!(period_end("month", 2026, 2), Some(ymd(2026, 2, 28)));
    }

    #[test]
    fn serials_sequence_increments_numeric_tail() {
        let s = generate_serials("sequence", Some("WID-0010"), &[], 3);
        assert_eq!(
            s,
            vec![
                Some("WID-0010".into()),
                Some("WID-0011".into()),
                Some("WID-0012".into())
            ]
        );
        // width grows naturally past the padding
        let s2 = generate_serials("sequence", Some("A099"), &[], 2);
        assert_eq!(s2, vec![Some("A099".into()), Some("A100".into())]);
        // pure integer
        let s3 = generate_serials("sequence", Some("1000"), &[], 2);
        assert_eq!(s3, vec![Some("1000".into()), Some("1001".into())]);
    }

    #[test]
    fn serials_list_positional_and_none() {
        let list = vec!["SN1".to_string(), "".to_string(), "SN3".to_string()];
        let s = generate_serials("list", None, &list, 4);
        assert_eq!(s, vec![Some("SN1".into()), None, Some("SN3".into()), None]);
        assert_eq!(
            generate_serials("none", Some("X1"), &[], 2),
            vec![None, None]
        );
    }

    #[test]
    fn explode_even_quarter() {
        let d = DemandInput {
            id: "d1".into(),
            product_id: "p".into(),
            period_type: "quarter".into(),
            year: 2026,
            period_index: 3,
            quantity: 4,
            spread_mode: "even".into(),
        };
        let dates = explode_due_dates(&d);
        assert_eq!(dates.len(), 4);
        // Last unit should land on the period end
        assert_eq!(*dates.last().unwrap(), ymd(2026, 9, 30));
        // Dates should be non-decreasing
        for w in dates.windows(2) {
            assert!(w[0] <= w[1]);
        }
    }

    #[test]
    fn explode_start_end_modes() {
        let d = DemandInput {
            id: "d1".into(),
            product_id: "p".into(),
            period_type: "quarter".into(),
            year: 2026,
            period_index: 1,
            quantity: 3,
            spread_mode: "start".into(),
        };
        assert_eq!(explode_due_dates(&d), vec![ymd(2026, 1, 1); 3]);
        let d_end = DemandInput {
            spread_mode: "end".into(),
            ..d
        };
        assert_eq!(explode_due_dates(&d_end), vec![ymd(2026, 3, 31); 3]);
    }

    #[test]
    fn bay_changeover_blocks_adjacent_jobs() {
        let mut bay = Bay::default();
        bay.reserve(ymd(2026, 1, 10), ymd(2026, 1, 12));
        assert!(bay.is_free(ymd(2026, 1, 13), ymd(2026, 1, 15), 0));
        assert!(!bay.is_free(ymd(2026, 1, 13), ymd(2026, 1, 15), 1));
        assert!(bay.is_free(ymd(2026, 1, 14), ymd(2026, 1, 15), 1));
    }

    fn sample_scenario_one_unit_fits() -> ScheduleInput {
        ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "Widget".into(),
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
                quantity: 1,
                spread_mode: "even".into(),
            }],
        }
    }

    #[test]
    fn empty_input_is_ok() {
        let out = run_schedule(&ScheduleInput {
            factories: vec![],
            products: vec![],
            demand: vec![],
        });
        assert_eq!(out.total_demand, 0);
        assert_eq!(out.shipped_on_time, 0);
        assert_eq!(out.unshippable, 0);
    }

    #[test]
    fn single_unit_fits() {
        let out = run_schedule(&sample_scenario_one_unit_fits());
        assert_eq!(out.total_demand, 1);
        assert_eq!(out.shipped_on_time, 1);
        assert_eq!(out.unshippable, 0);
        let u = &out.units[0];
        assert_eq!(u.due_date, ymd(2026, 9, 30));
        assert_eq!(u.required_start, ymd(2026, 9, 26)); // 5-day LT inclusive: 26..30 = 5 days
        assert_eq!(u.factory_id.as_deref(), Some("f1"));
        assert_eq!(u.bay_index, Some(0));
    }

    #[test]
    fn demand_spreads_across_factories() {
        // 2 factories, 2 bays each. 10 units evenly spread over Q3.
        // With load-balanced placement, both factories should get units.
        let s = ScheduleInput {
            factories: vec![
                FactoryInput {
                    id: "fA".into(),
                    name: "A".into(),
                    bays: 2,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
                FactoryInput {
                    id: "fB".into(),
                    name: "B".into(),
                    bays: 2,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
            ],
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
                quantity: 10,
                spread_mode: "even".into(),
            }],
        };
        let out = run_schedule(&s);
        assert_eq!(out.shipped_on_time, 10);
        let mut count_a: i64 = 0;
        let mut count_b: i64 = 0;
        for u in &out.units {
            match u.factory_id.as_deref() {
                Some("fA") => count_a += 1,
                Some("fB") => count_b += 1,
                _ => {}
            }
        }
        assert!(count_a > 0, "Factory A should receive units, got {count_a}");
        assert!(count_b > 0, "Factory B should receive units, got {count_b}");
        // Should be roughly balanced (each factory carries ~half)
        let diff = (count_a - count_b).abs();
        assert!(
            diff <= 2,
            "factories should be balanced; got A={count_a}, B={count_b}"
        );
    }

    #[test]
    fn demand_spreads_across_bays_within_factory() {
        // Single factory, 4 bays. 8 units evenly spread. Every bay should be used.
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 4,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
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
                quantity: 8,
                spread_mode: "even".into(),
            }],
        };
        let out = run_schedule(&s);
        assert_eq!(out.shipped_on_time, 8);
        let mut bay_counts = [0i64; 4];
        for u in &out.units {
            if let Some(b) = u.bay_index {
                bay_counts[b as usize] += 1;
            }
        }
        // All 4 bays should have at least one unit
        for (i, &c) in bay_counts.iter().enumerate() {
            assert!(c > 0, "bay {i} unused; counts = {bay_counts:?}");
        }
    }

    #[test]
    fn variable_bays_shrinking_quarter_limits_capacity() {
        // Factory has baseline of 4 bays, but Q3 2026 is overridden to 1 bay.
        // 4 units due in Q3 (5-day LT, non-overlapping windows) — with 1 bay
        // available, all 4 still fit sequentially. Add a 5th unit competing for
        // the same exact window and that one becomes unshippable.
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 4,
                changeover_days: 0,
                bay_counts_by_quarter: vec![BayCountInput {
                    year: 2026,
                    quarter: 3,
                    bays: 1,
                }],
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
                quantity: 6,
                spread_mode: "end".into(), // all due same day -> all need same window
            }],
        };
        let out = run_schedule(&s);
        // Only 1 fits on-time in Q3 (1-bay override). The other 5 roll forward
        // into later quarters and ship late; none are truly unshippable.
        assert_eq!(
            out.shipped_on_time, 1,
            "should be capped by Q3 override of 1 bay"
        );
        assert_eq!(out.shipped_late, 5);
        assert_eq!(out.unshippable, 0);
        // 5 units missed Q3 2026 and rolled forward.
        let q3 = out
            .quarter_misses
            .iter()
            .find(|m| m.year == 2026 && m.quarter == 3)
            .expect("Q3 2026 miss recorded");
        assert_eq!(q3.count, 5);
    }

    #[test]
    fn variable_bays_increasing_quarter_expands_capacity() {
        // Baseline 1 bay; Q3 2026 overridden to 4 bays. Six units all due Sep 30
        // should now fit (was capped at 1 in the previous test).
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![BayCountInput {
                    year: 2026,
                    quarter: 3,
                    bays: 4,
                }],
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
                quantity: 4,
                spread_mode: "end".into(),
            }],
        };
        let out = run_schedule(&s);
        assert_eq!(out.shipped_on_time, 4);
        assert_eq!(out.unshippable, 0);
    }

    #[test]
    fn factory_lead_time_override_changes_window_length() {
        // Base LT = 5 days (fits Q3, on time). A 20-day override at the only
        // factory makes the *same* unit occupy a 20-day window instead, proving
        // the per-factory lead time is applied during placement.
        let base = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
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
                quantity: 1,
                spread_mode: "end".into(),
            }],
        };
        let out_base = run_schedule(&base);
        assert_eq!(out_base.shipped_on_time, 1);
        let u = &out_base.units[0];
        assert_eq!((u.due_date - u.required_start).num_days() + 1, 5);

        let mut over = base.clone();
        over.products[0].factory_lead_times = vec![FactoryLeadTimeInput {
            factory_id: "f1".into(),
            year: 2026,
            quarter: 3,
            lead_time_days: 20,
        }];
        let out_over = run_schedule(&over);
        let u2 = &out_over.units[0];
        assert_eq!(u2.factory_id.as_deref(), Some("f1"));
        // Window now reflects the factory override (20 days), not the base (5).
        assert_eq!((u2.due_date - u2.required_start).num_days() + 1, 20);
    }

    #[test]
    fn maximize_utilization_packs_into_fewest_bays() {
        // 1 factory, 4 bays. 3 units with short, non-overlapping windows across
        // Q3. Load-balancing spreads them across bays; utilization-packing stacks
        // them all into bay 0, leaving the other bays empty.
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 4,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
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
                spread_mode: "even".into(),
            }],
        };

        let balanced = run_schedule_mode(&s, BayAssignment::BalanceLoad);
        let max_bay_balanced = balanced
            .units
            .iter()
            .filter_map(|u| u.bay_index)
            .max()
            .unwrap();
        assert!(
            max_bay_balanced >= 1,
            "load-balancing should spread across bays"
        );

        let packed = run_schedule_mode(&s, BayAssignment::MaximizeUtilization);
        assert!(
            packed.units.iter().all(|u| u.bay_index == Some(0)),
            "utilization mode should pack every unit into bay 0"
        );
        assert_eq!(packed.shipped_on_time, 3);
    }

    #[test]
    fn utilization_prefers_smallest_gap_bay() {
        // One factory, 3 bays. Bay 0 last used through Jan 10; bay 1 through
        // Jan 20. A new unit starting Jan 25 should take bay 1 (gap 4) over bay 0
        // (gap 14) and over the empty bay 2 — tightest fit, reuse first.
        let facs = vec![FactoryInput {
            id: "f1".into(),
            name: "F1".into(),
            bays: 3,
            changeover_days: 0,
            bay_counts_by_quarter: vec![],
        }];
        let mut pool = BayPool::from_factories_with(&facs, BayAssignment::MaximizeUtilization);
        pool.reserve(0, ymd(2026, 1, 1), ymd(2026, 1, 10));
        pool.reserve(1, ymd(2026, 1, 1), ymd(2026, 1, 20));

        let (s, f, idx) = pool
            .find_free_window(|_fid| (ymd(2026, 1, 25), ymd(2026, 1, 30)))
            .expect("a free bay");
        assert_eq!(idx, 1, "should reuse the bay leaving the smallest gap");
        assert_eq!((s, f), (ymd(2026, 1, 25), ymd(2026, 1, 30)));
    }

    #[test]
    fn balance_prefers_emptiest_bay() {
        // Same setup, BalanceLoad picks the emptiest bay (bay 2, 0 load).
        let facs = vec![FactoryInput {
            id: "f1".into(),
            name: "F1".into(),
            bays: 3,
            changeover_days: 0,
            bay_counts_by_quarter: vec![],
        }];
        let mut pool = BayPool::from_factories_with(&facs, BayAssignment::BalanceLoad);
        pool.reserve(0, ymd(2026, 1, 1), ymd(2026, 1, 10));
        pool.reserve(1, ymd(2026, 1, 1), ymd(2026, 1, 20));

        let (_, _, idx) = pool
            .find_free_window(|_fid| (ymd(2026, 1, 25), ymd(2026, 1, 30)))
            .expect("a free bay");
        assert_eq!(idx, 2, "load-balancing should pick the empty bay");
    }

    #[test]
    fn factory_lead_time_override_only_targets_named_factory() {
        // Two factories. f2 gets a huge override; f1 keeps the base LT. With one
        // unit and equal (empty) load, placement prefers f1 (lowest pool index),
        // so the override on f2 must not affect f1's window.
        let s = ScheduleInput {
            factories: vec![
                FactoryInput {
                    id: "f1".into(),
                    name: "F1".into(),
                    bays: 1,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
                FactoryInput {
                    id: "f2".into(),
                    name: "F2".into(),
                    bays: 1,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
            ],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times: vec![LeadTimeInput {
                    year: 2026,
                    quarter: 3,
                    lead_time_days: 5,
                }],
                factory_lead_times: vec![FactoryLeadTimeInput {
                    factory_id: "f2".into(),
                    year: 2026,
                    quarter: 3,
                    lead_time_days: 90,
                }],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: 2026,
                period_index: 3,
                quantity: 1,
                spread_mode: "end".into(),
            }],
        };
        let out = run_schedule(&s);
        let u = &out.units[0];
        assert_eq!(u.factory_id.as_deref(), Some("f1"));
        assert_eq!((u.due_date - u.required_start).num_days() + 1, 5);
        assert_eq!(out.shipped_on_time, 1);
    }

    #[test]
    fn variable_bays_window_crossing_quarter_uses_min() {
        // Window crosses Q1->Q2 boundary. Q1 has 1 bay, Q2 has 4 bays.
        // Bays beyond index 0 are unusable in any cross-quarter window because
        // min(1, 4) = 1.
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 4,
                changeover_days: 0,
                bay_counts_by_quarter: vec![
                    BayCountInput {
                        year: 2026,
                        quarter: 1,
                        bays: 1,
                    },
                    BayCountInput {
                        year: 2026,
                        quarter: 2,
                        bays: 4,
                    },
                ],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                // 40-day LT for a unit due Apr 10 -> window [Mar 2, Apr 10] crosses Q1/Q2
                lead_times: vec![LeadTimeInput {
                    year: 2026,
                    quarter: 2,
                    lead_time_days: 40,
                }],
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "month".into(),
                year: 2026,
                period_index: 4, // April
                quantity: 4,
                spread_mode: "start".into(), // all due Apr 1
            }],
        };
        let out = run_schedule(&s);
        // The first unit's window spans Q1/Q2 and is gated to min(1,4)=1 bay, so
        // it takes the single cross-quarter slot. The other three ship slightly
        // later but still within Q2 (4 bays for windows entirely inside Q2), so
        // all four are on time for their demanded quarter — none roll out.
        assert_eq!(out.shipped_on_time, 4);
        assert_eq!(out.shipped_late, 0);
        assert_eq!(out.unshippable, 0);
        assert!(out.quarter_misses.is_empty());
    }

    #[test]
    fn capacity_limited_shortfall() {
        // 1 bay, 5-day LT, but 3 units due same day -> only 1 fits on-time in Q3.
        // The other 2 roll forward (1 bay every quarter) and ship late.
        let mut s = sample_scenario_one_unit_fits();
        s.demand[0].quantity = 3;
        s.demand[0].spread_mode = "end".into();
        let out = run_schedule(&s);
        assert_eq!(out.total_demand, 3);
        assert_eq!(out.shipped_on_time, 1);
        assert_eq!(out.shipped_late, 2);
        assert_eq!(out.unshippable, 0);
        // 2 missed Q3 2026.
        let q3 = out
            .quarter_misses
            .iter()
            .find(|m| m.year == 2026 && m.quarter == 3)
            .expect("Q3 2026 miss recorded");
        assert_eq!(q3.count, 2);
    }

    #[test]
    fn roll_forward_ships_late_next_quarter() {
        // 1 bay; 2 units both due end of Q1 2026 with a short LT. One ships
        // on-time in Q1, the other rolls to Q2 and ships late. No misses beyond Q1.
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times: vec![
                    LeadTimeInput {
                        year: 2026,
                        quarter: 1,
                        lead_time_days: 5,
                    },
                    LeadTimeInput {
                        year: 2026,
                        quarter: 2,
                        lead_time_days: 5,
                    },
                ],
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: 2026,
                period_index: 1,
                quantity: 2,
                spread_mode: "end".into(), // both due Mar 31
            }],
        };
        let out = run_schedule(&s);
        assert_eq!(out.shipped_on_time, 1);
        assert_eq!(out.shipped_late, 1);
        assert_eq!(out.unshippable, 0);
        // The late unit builds from the first day of Q2 (Apr 1) and, with a
        // 5-day lead time, ships Apr 5 — the earliest possible date in Q2.
        let late = out
            .units
            .iter()
            .find(|u| u.status == UnitStatus::Late)
            .unwrap();
        assert_eq!(late.required_start, ymd(2026, 4, 1));
        assert_eq!(late.due_date, ymd(2026, 4, 5));
        assert_eq!(late.orig_due_date, ymd(2026, 3, 31));
        // Exactly one unit missed Q1 2026.
        assert_eq!(
            out.quarter_misses,
            vec![QuarterMiss {
                year: 2026,
                quarter: 1,
                count: 1
            }]
        );
    }

    #[test]
    fn cross_quarter_lead_time_uses_due_quarter() {
        // LT differs Q1 vs Q2; due date is April 5 (Q2) -> should use Q2 LT
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 1,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
            }],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times: vec![
                    LeadTimeInput {
                        year: 2026,
                        quarter: 1,
                        lead_time_days: 100,
                    },
                    LeadTimeInput {
                        year: 2026,
                        quarter: 2,
                        lead_time_days: 5,
                    },
                ],
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "month".into(),
                year: 2026,
                period_index: 4, // April
                quantity: 1,
                spread_mode: "end".into(),
            }],
        };
        let out = run_schedule(&s);
        let u = &out.units[0];
        assert_eq!(u.due_date, ymd(2026, 4, 30));
        // 5-day LT means required_start = Apr 26
        assert_eq!(u.required_start, ymd(2026, 4, 26));
    }

    #[test]
    fn multiple_bays_load_balance() {
        // 2 bays, 4 units of 5-day LT all due Sep 30 -> 2 ship on-time in Q3; the
        // other 2 roll forward to Q4 and ship late (none unshippable).
        let s = ScheduleInput {
            factories: vec![FactoryInput {
                id: "f1".into(),
                name: "F1".into(),
                bays: 2,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
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
                quantity: 4,
                spread_mode: "end".into(),
            }],
        };
        let out = run_schedule(&s);
        assert_eq!(out.shipped_on_time, 2);
        assert_eq!(out.shipped_late, 2);
        assert_eq!(out.unshippable, 0);
    }

    // ---------- Strategy benchmark ----------

    /// (on_time, late, unshippable, total_lateness_qtrs, max_lateness_qtrs, makespan_qtrs)
    fn metrics(out: &ScheduleOutput) -> (usize, usize, usize, i64, i64, i64) {
        let mut total_lat = 0i64;
        let mut max_lat = 0i64;
        let mut min_qi = i64::MAX;
        let mut max_ship_qi = i64::MIN;
        for u in &out.units {
            let oq = quarter_index(u.orig_due_date.year() as i64, quarter_of(u.orig_due_date));
            min_qi = min_qi.min(oq);
            if u.status != UnitStatus::Unshippable {
                let sq = quarter_index(u.due_date.year() as i64, quarter_of(u.due_date));
                let lat = sq - oq;
                total_lat += lat;
                max_lat = max_lat.max(lat);
                max_ship_qi = max_ship_qi.max(sq);
            }
        }
        let makespan = if max_ship_qi >= min_qi {
            max_ship_qi - min_qi + 1
        } else {
            0
        };
        (
            out.shipped_on_time,
            out.shipped_late,
            out.unshippable,
            total_lat,
            max_lat,
            makespan,
        )
    }

    /// Build a benchmark scenario: `factories` factories of `bays` bays each, one
    /// product with lead time `lt`, and `per_q` units demanded every quarter for
    /// `qtrs` quarters starting 2026 Q1 (even spread).
    fn bench_scenario(
        factories: usize,
        bays: i64,
        lt: i64,
        qtrs: usize,
        per_q: i64,
    ) -> ScheduleInput {
        let facs = (0..factories)
            .map(|i| FactoryInput {
                id: format!("f{i}"),
                name: format!("F{i}"),
                bays,
                changeover_days: 0,
                bay_counts_by_quarter: vec![],
            })
            .collect();
        // Define lead times generously across years so roll-offs find an LT.
        let mut lead_times = Vec::new();
        for y in 2026..=2031 {
            for q in 1..=4 {
                lead_times.push(LeadTimeInput {
                    year: y,
                    quarter: q,
                    lead_time_days: lt,
                });
            }
        }
        let mut demand = Vec::new();
        for k in 0..qtrs {
            let (y, q) = (2026 + (k / 4) as i64, (k % 4) as i64 + 1);
            demand.push(DemandInput {
                id: format!("d{k}"),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: y,
                period_index: q,
                quantity: per_q,
                spread_mode: "even".into(),
            });
        }
        ScheduleInput {
            factories: facs,
            products: vec![ProductInput {
                id: "p1".into(),
                name: "P".into(),
                lead_times,
                factory_lead_times: vec![],
                factory_allocations: vec![],
            }],
            demand,
        }
    }

    /// Run all strategies on several scenarios and print a comparison table.
    /// Run with: `cargo test benchmark_strategies -- --nocapture`
    #[test]
    fn benchmark_strategies() {
        let scenarios: Vec<(&str, ScheduleInput)> = vec![
            (
                "slack       (12 bays, lt30, 8q x5)",
                bench_scenario(2, 6, 30, 8, 5),
            ),
            (
                "moderate    (8 bays,  lt60, 8q x6)",
                bench_scenario(2, 4, 60, 8, 6),
            ),
            (
                "heavy       (14 bays, lt100,6q x12)",
                bench_scenario(2, 7, 100, 6, 12),
            ),
            (
                "very-heavy  (8 bays,  lt90, 8q x10)",
                bench_scenario(2, 4, 90, 8, 10),
            ),
        ];
        let strategies = [
            ("BackwardGreedy ", Strategy::BackwardGreedy),
            ("FifoAsap       ", Strategy::FifoAsap),
            ("Backward+Fwd   ", Strategy::BackwardThenForward),
            ("QuarterCarry   ", Strategy::QuarterCarryover),
            ("RollFwdPriority", Strategy::RollForwardPriority),
        ];

        println!("\n=== Scheduling strategy benchmark ===");
        println!("metrics: on-time / late / unshippable | total-lateness(qtrs) max-late makespan(qtrs)\n");
        for (name, input) in &scenarios {
            let total: usize = input.demand.iter().map(|d| d.quantity as usize).sum();
            println!("Scenario {name}  (demand={total})");
            for (label, strat) in &strategies {
                let out = run_schedule_strategy(input, *strat);
                let (ot, late, uns, tl, ml, mk) = metrics(&out);
                println!(
                    "  {label} on-time {ot:>4}  late {late:>4}  uns {uns:>4}  | tot-late {tl:>5}  max-late {ml:>2}  makespan {mk:>2}"
                );
            }
            println!();
        }
    }

    #[test]
    fn product_allocation_can_force_units_to_one_factory() {
        let input = ScheduleInput {
            factories: vec![
                FactoryInput {
                    id: "f1".into(),
                    name: "Factory 1".into(),
                    bays: 4,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
                FactoryInput {
                    id: "f2".into(),
                    name: "Factory 2".into(),
                    bays: 4,
                    changeover_days: 0,
                    bay_counts_by_quarter: vec![],
                },
            ],
            products: vec![ProductInput {
                id: "p1".into(),
                name: "Product".into(),
                lead_times: vec![LeadTimeInput {
                    year: 2026,
                    quarter: 1,
                    lead_time_days: 5,
                }],
                factory_lead_times: vec![],
                factory_allocations: vec![FactoryAllocationInput {
                    factory_id: "f2".into(),
                    year: 0,
                    quarter: 0,
                    allocation_pct: 100,
                }],
            }],
            demand: vec![DemandInput {
                id: "d1".into(),
                product_id: "p1".into(),
                period_type: "quarter".into(),
                year: 2026,
                period_index: 1,
                quantity: 6,
                spread_mode: "even".into(),
            }],
        };

        let out = run_schedule(&input);
        assert_eq!(out.unshippable, 0);
        assert!(out
            .units
            .iter()
            .all(|u| u.factory_id.as_deref() == Some("f2")));
    }
}

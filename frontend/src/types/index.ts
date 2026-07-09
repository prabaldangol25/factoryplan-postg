export interface Scenario {
  id: string
  name: string
  created_at: string
  updated_at: string
  is_active: boolean
}

export interface BayCountRow {
  id: string
  factory_id: string
  year: number
  quarter: number
  bays: number
}

export interface BayWeekRow {
  id: string
  factory_id: string
  week_start: string
  bays: number
}

export interface Factory {
  id: string
  scenario_id: string
  name: string
  bays: number
  changeover_days: number
  bay_counts: BayCountRow[]
  bay_weeks: BayWeekRow[]
}

export interface LeadTimeRow {
  id: string
  product_id: string
  year: number
  quarter: number
  lead_time_days: number
}

export interface FactoryLeadTimeRow {
  id: string
  product_id: string
  factory_id: string
  year: number
  quarter: number
  lead_time_days: number
}

export interface FactoryAllocationRow {
  id: string
  product_id: string
  factory_id: string
  year: number
  quarter: number
  allocation_pct: number
}

export interface Product {
  id: string
  scenario_id: string
  name: string
  lead_times: LeadTimeRow[]
  factory_lead_times: FactoryLeadTimeRow[]
  factory_allocations: FactoryAllocationRow[]
}

export interface ScenarioOrder {
  id: string
  scenario_id: string
  utid: string
  build_type: string
  customer: string
  cycle_time_days: number
  sort_order: number
  due_date?: string
}

export type PeriodType = 'month' | 'quarter'
export type SpreadMode = 'even' | 'start' | 'end'
export type SerialMode = 'none' | 'sequence' | 'list'

export interface Demand {
  id: string
  scenario_id: string
  product_id: string
  period_type: PeriodType
  year: number
  period_index: number
  quantity: number
  spread_mode: SpreadMode
  serial_mode: SerialMode
  serial_start: string | null
  serial_list: string | null
}

export interface ScheduleRun {
  id: string
  scenario_id: string
  run_at: string
  total_demand: number
  shipped_on_time: number
  shipped_late: number
  unshippable: number
}

export interface QuarterMiss {
  id: string
  run_id: string
  year: number
  quarter: number
  missed_count: number
}

export interface ScheduledUnit {
  id: string
  run_id: string
  demand_id: string
  product_id: string
  factory_id: string | null
  bay_index: number | null
  required_start: string
  due_date: string
  status: 'shipped' | 'unshippable'
  serial: string | null
  orig_due_date: string | null
  is_late: boolean
  is_anchored?: boolean
}

export interface PerProductLtTarget {
  product_id: string
  product_name: string
  current_lead_time_days: number
  target_lead_time_days: number
}

export interface BaysNeededRec {
  bays_to_add: number
  suggested_factory_id: string | null
  suggested_factory_name: string | null
}

export interface UniformLtPctRec {
  reduction_pct: number
}

export interface Recommendation {
  bays_needed: BaysNeededRec | null
  uniform_lt_pct: UniformLtPctRec | null
  per_product_lt: PerProductLtTarget[]
  quarter_fixes: QuarterFixRec[]
}

export interface QuarterFixRec {
  year: number
  quarter: number
  missed_count: number
  bays_to_add: number | null
  suggested_factory_id: string | null
  suggested_factory_name: string | null
  ct_reduction_pct: number | null
  ct_capacity_bound: boolean
}

export interface RunResult {
  run: ScheduleRun
  units: ScheduledUnit[]
  recommendation: Recommendation
  quarter_misses: QuarterMiss[]
  alternatives?: RunAlternative[]
}

export interface RunAlternative {
  kind: string
  label: string
  description: string
  total_demand: number
  shipped_on_time: number
  shipped_late: number
  unshippable: number
  units: ScheduledUnit[]
}

// ---------- Agent (Devin-powered scheduling chat) ----------

export interface AgentConversation {
  id: string
  scenario_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

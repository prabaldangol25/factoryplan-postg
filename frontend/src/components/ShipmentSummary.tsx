import { useMemo } from 'react'
import type { Demand, Factory, Product, RunResult } from '../types'

interface Props {
  result: RunResult
  demand: Demand[]
  products: Product[]
  factories: Factory[]
}

interface SubRow {
  factory: string
  shipped: number
  shippedLater: number
}

interface Group {
  key: string
  label: string
  product: string
  demand: number
  extraBaysFor100: number | null
  baysRequired: number | null
  baysAvailable: number | null
  baysAvailableDetail: string | null
  ctReductionDays: number | null
  subrows: SubRow[]
}

const NO_SHIPMENTS_LABEL = '(no shipments)'
const DAY = 86400000

function periodLabel(d: Demand): { label: string; key: string } {
  if (d.period_type === 'quarter') {
    return { label: `${d.year} · Q${d.period_index}`, key: `${d.year}-Q${d.period_index}` }
  }
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return {
    label: `${months[d.period_index - 1]} ${d.year}`,
    key: `${d.year}-M${d.period_index.toString().padStart(2, '0')}`,
  }
}

function periodStart(d: Demand): number | null {
  if (d.period_type === 'quarter') {
    const month = [1, 4, 7, 10][d.period_index - 1]
    return month ? Date.UTC(d.year, month - 1, 1) : null
  }
  if (d.period_type === 'month' && d.period_index >= 1 && d.period_index <= 12) {
    return Date.UTC(d.year, d.period_index - 1, 1)
  }
  return null
}

function periodEnd(d: Demand): number | null {
  const start = periodStart(d)
  if (start == null) return null
  const dt = new Date(start)
  const next =
    d.period_type === 'quarter'
      ? Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 3, 1)
      : Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1)
  return next - DAY
}

function explodeDueDates(d: Demand): number[] {
  const start = periodStart(d)
  const end = periodEnd(d)
  if (start == null || end == null) return []
  const n = Math.max(0, d.quantity)
  if (n === 0) return []
  if (d.spread_mode === 'start') return Array(n).fill(start)
  if (d.spread_mode === 'end') return Array(n).fill(end)
  if (n === 1) return [end]
  const daysSpan = Math.round((end - start) / DAY)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const frac = (i + 1) / n
    out.push(start + Math.max(0, Math.min(daysSpan, Math.round(frac * (daysSpan + 1) - 1))) * DAY)
  }
  return out
}

function quarterOf(ms: number): number {
  return Math.floor(new Date(ms).getUTCMonth() / 3) + 1
}

function quarterKey(ms: number): string {
  return `${new Date(ms).getUTCFullYear()}-Q${quarterOf(ms)}`
}

function demandQuarter(d: Demand): { year: number; quarter: number; key: string } | null {
  if (d.period_type === 'quarter') {
    if (d.period_index < 1 || d.period_index > 4) return null
    return { year: d.year, quarter: d.period_index, key: `${d.year}-Q${d.period_index}` }
  }
  if (d.period_type === 'month' && d.period_index >= 1 && d.period_index <= 12) {
    const quarter = Math.floor((d.period_index - 1) / 3) + 1
    return { year: d.year, quarter, key: `${d.year}-Q${quarter}` }
  }
  return null
}

function qIndex(year: number, quarter: number): number {
  return year * 4 + (quarter - 1)
}

function lookupQuarterly(map: Map<string, number>, year: number, quarter: number): number | null {
  const exact = map.get(`${year}-${quarter}`)
  if (exact != null) return exact
  const target = qIndex(year, quarter)
  let best: { idx: number; val: number } | null = null
  let any: number | null = null
  for (const [k, v] of map) {
    const [y, q] = k.split('-').map(Number)
    any = v
    const idx = qIndex(y, q)
    if (idx <= target && (!best || idx > best.idx)) best = { idx, val: v }
  }
  return best?.val ?? any
}

function worstCaseLt(p: Product | undefined, dueMs: number): number {
  if (!p) return 1
  const year = new Date(dueMs).getUTCFullYear()
  const quarter = quarterOf(dueMs)
  const candidates: number[] = []
  const base = new Map<string, number>()
  for (const lt of p.lead_times) base.set(`${lt.year}-${lt.quarter}`, lt.lead_time_days)
  const baseLt = lookupQuarterly(base, year, quarter)
  if (baseLt != null) candidates.push(baseLt)
  const byFactory = new Map<string, Map<string, number>>()
  for (const flt of p.factory_lead_times ?? []) {
    let m = byFactory.get(flt.factory_id)
    if (!m) {
      m = new Map()
      byFactory.set(flt.factory_id, m)
    }
    m.set(`${flt.year}-${flt.quarter}`, flt.lead_time_days)
  }
  for (const m of byFactory.values()) {
    const lt = lookupQuarterly(m, year, quarter)
    if (lt != null) candidates.push(lt)
  }
  return candidates.length ? Math.max(1, Math.max(...candidates)) : 1
}

function effectiveBays(f: Factory, year: number, quarter: number): number {
  const override = f.bay_counts.find((bc) => bc.year === year && bc.quarter === quarter)
  return override ? override.bays : f.bays
}

function bayRequirementByQuarter(demand: Demand[], products: Product[]): Map<string, number> {
  const productById = new Map(products.map((p) => [p.id, p]))
  const units: Array<{ start: number; due: number }> = []
  for (const d of demand) {
    const p = productById.get(d.product_id)
    for (const due of explodeDueDates(d)) {
      const lt = worstCaseLt(p, due)
      units.push({ start: due - (lt - 1) * DAY, due })
    }
  }
  const out = new Map<string, number>()
  if (units.length === 0) return out
  const minStart = Math.min(...units.map((u) => u.start))
  const maxDue = Math.max(...units.map((u) => u.due))
  const numDays = Math.round((maxDue - minStart) / DAY) + 1
  const diff = new Array(numDays + 1).fill(0)
  for (const u of units) {
    const si = Math.round((u.start - minStart) / DAY)
    const di = Math.round((u.due - minStart) / DAY)
    diff[si]++
    diff[di + 1]--
  }
  let run = 0
  for (let i = 0; i < numDays; i++) {
    run += diff[i]
    const key = quarterKey(minStart + i * DAY)
    out.set(key, Math.max(out.get(key) ?? 0, run))
  }
  return out
}

function baysAvailableByQuarter(factories: Factory[], year: number, quarter: number): number {
  return factories.reduce((s, f) => s + effectiveBays(f, year, quarter), 0)
}

function baysAvailableDetailByQuarter(factories: Factory[], year: number, quarter: number): string {
  return factories.map((f) => `${f.name}: ${effectiveBays(f, year, quarter)}`).join(', ')
}

export function ShipmentSummary({ result, demand, products, factories }: Props) {
  const productName = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of products) m.set(p.id, p.name)
    return m
  }, [products])

  const factoryName = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of factories) m.set(f.id, f.name)
    return m
  }, [factories])

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = []
    const bayReqByQuarter = bayRequirementByQuarter(demand, products)
    for (const d of demand) {
      const { label, key } = periodLabel(d)
      const units = result.units.filter((u) => u.demand_id === d.id)
      const q = demandQuarter(d)
      const baysRequired = q ? bayReqByQuarter.get(q.key) ?? null : null
      const baysAvailable = q ? baysAvailableByQuarter(factories, q.year, q.quarter) : null
      const baysAvailableDetail = q ? baysAvailableDetailByQuarter(factories, q.year, q.quarter) : null
      const extraBaysFor100 =
        baysRequired != null && baysAvailable != null ? Math.max(0, baysRequired - baysAvailable) : null
      const dueDates = explodeDueDates(d)
      const currentCtDays = dueDates.length
        ? Math.max(...dueDates.map((due) => worstCaseLt(products.find((p) => p.id === d.product_id), due)))
        : null
      const ctReductionDays =
        baysRequired != null && baysAvailable != null && currentCtDays != null
          ? baysRequired > 0
            ? Math.max(0, (1 - baysAvailable / baysRequired) * currentCtDays)
            : 0
          : null

      // Group shipped units by factory.
      const byFactory = new Map<string, SubRow>()
      // Seed with every factory so empty ones are visible
      for (const f of factories) {
        byFactory.set(f.id, {
          factory: f.name,
          shipped: 0,
          shippedLater: 0,
        })
      }
      for (const u of units) {
        if (u.status === 'unshippable' || u.factory_id == null) {
          continue
        }
        const row = byFactory.get(u.factory_id) ?? {
          factory: factoryName.get(u.factory_id) ?? '(unknown)',
          shipped: 0,
          shippedLater: 0,
        }
        if (u.is_late) row.shippedLater += 1
        else row.shipped += 1
        byFactory.set(u.factory_id, row)
      }
      // Keep factory order stable (matches factories prop order)
      const subrows: SubRow[] = []
      for (const f of factories) {
        const r = byFactory.get(f.id)
        if (r && (r.shipped > 0 || r.shippedLater > 0)) {
          subrows.push(r)
        }
      }
      // Factories not in the prop list (defensive)
      for (const [fid, r] of byFactory.entries()) {
        if (!factories.find((f) => f.id === fid) && (r.shipped > 0 || r.shippedLater > 0)) {
          subrows.push(r)
        }
      }
      // If nothing shipped, still show one row so the demand is visible.
      if (subrows.length === 0) {
        subrows.push({
          factory: NO_SHIPMENTS_LABEL,
          shipped: 0,
          shippedLater: 0,
        })
      }

      out.push({
        key: `${key}-${d.product_id}-${d.id}`,
        label,
        product: productName.get(d.product_id) ?? '(unknown)',
        demand: d.quantity,
        extraBaysFor100,
        baysRequired,
        baysAvailable,
        baysAvailableDetail,
        ctReductionDays,
        subrows,
      })
    }
    out.sort((a, b) => a.label.localeCompare(b.label) || a.product.localeCompare(b.product))
    return out
  }, [
    demand,
    factories,
    factoryName,
    productName,
    products,
    result.units,
  ])

  // Grand totals
  const totals = groups.reduce(
    (acc, g) => {
      const shipped = g.subrows.reduce((s, r) => s + r.shipped, 0)
      const shippedLater = g.subrows.reduce((s, r) => s + r.shippedLater, 0)
      acc.demand += g.demand
      acc.shipped += shipped
      acc.shippedLater += shippedLater
      return acc
    },
    { demand: 0, shipped: 0, shippedLater: 0 },
  )
  const totalsOnTimePct = totals.demand > 0 ? (totals.shipped / totals.demand) * 100 : 0

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Period</th>
            <th className="text-left px-3 py-2 font-medium">Product</th>
            <th className="text-left px-3 py-2 font-medium">Factory</th>
            <th className="text-right px-3 py-2 font-medium">Demand</th>
            <th className="text-right px-3 py-2 font-medium">Shipped</th>
            <th className="text-right px-3 py-2 font-medium">Shipped later</th>
            <th className="text-right px-3 py-2 font-medium w-24">On-time %</th>
            <th className="text-right px-3 py-2 font-medium">Bays needed</th>
            <th className="text-right px-3 py-2 font-medium">Bays avail / peak need</th>
            <th className="text-right px-3 py-2 font-medium">CT reduction (days)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groups.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                No demand to summarize.
              </td>
            </tr>
          )}
          {groups.map((g) => {
            const groupShipped = g.subrows.reduce((s, r) => s + r.shipped, 0)
            const groupOnTimePct = g.demand > 0 ? (groupShipped / g.demand) * 100 : 0
            const onTimeColor =
              groupOnTimePct >= 100
                ? 'text-emerald-700'
                : groupOnTimePct >= 75
                  ? 'text-amber-700'
                  : 'text-rose-700'
            return g.subrows.map((sub, i) => (
              <tr key={`${g.key}-${i}`} className={i > 0 ? 'border-t-0' : ''}>
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 align-top border-t border-slate-100"
                  >
                    {g.label}
                  </td>
                )}
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 align-top border-t border-slate-100"
                  >
                    {g.product}
                  </td>
                )}
                <td
                  className={
                    'px-3 py-2 ' +
                    (sub.factory === NO_SHIPMENTS_LABEL ? 'text-slate-400 italic' : 'text-slate-700')
                  }
                >
                  {sub.factory}
                </td>
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 text-right align-top border-t border-slate-100"
                  >
                    {g.demand}
                  </td>
                )}
                <td className="px-3 py-2 text-right text-emerald-700">
                  {sub.shipped > 0 ? sub.shipped : ''}
                </td>
                <td className="px-3 py-2 text-right text-amber-700">
                  {sub.shippedLater > 0 ? sub.shippedLater : ''}
                </td>
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className={
                      'px-3 py-2 text-right font-medium align-top border-t border-slate-100 ' +
                      onTimeColor
                    }
                  >
                    {groupOnTimePct.toFixed(0)}%
                  </td>
                )}
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 text-right align-top border-t border-slate-100"
                  >
                    {g.extraBaysFor100 != null ? (
                      <span
                        className={
                          g.extraBaysFor100 > 0 ? 'font-medium text-slate-700' : 'text-slate-500'
                        }
                      >
                        +{g.extraBaysFor100}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                )}
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 text-right align-top border-t border-slate-100"
                  >
                    {g.baysAvailableDetail != null && g.baysRequired != null ? (
                      <div>
                        <div className="text-slate-700">{g.baysAvailableDetail}</div>
                        <div className="text-xs text-slate-500">peak need: {g.baysRequired}</div>
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                )}
                {i === 0 && (
                  <td
                    rowSpan={g.subrows.length}
                    className="px-3 py-2 text-right align-top border-t border-slate-100"
                  >
                    {g.ctReductionDays != null ? `${g.ctReductionDays.toFixed(1)} days` : ''}
                  </td>
                )}
              </tr>
            ))
          })}
        </tbody>
        {groups.length > 0 && (
          <tfoot className="bg-slate-50 font-medium">
            <tr>
              <td className="px-3 py-2" colSpan={3}>
                Total
              </td>
              <td className="px-3 py-2 text-right">{totals.demand}</td>
              <td className="px-3 py-2 text-right text-emerald-700">{totals.shipped}</td>
              <td className="px-3 py-2 text-right text-amber-700">{totals.shippedLater}</td>
              <td className="px-3 py-2 text-right">{totalsOnTimePct.toFixed(0)}%</td>
              <td className="px-3 py-2 text-right"></td>
              <td className="px-3 py-2 text-right"></td>
              <td className="px-3 py-2 text-right"></td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

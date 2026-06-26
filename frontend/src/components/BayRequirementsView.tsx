import { useEffect, useMemo, useState, type ReactNode } from 'react'
import PlotComponent from 'react-plotly.js'
import {
  BarChart3,
  Filter,
  LineChart,
  AreaChart,
  BarChart2,
  Layers,
} from 'lucide-react'
import type { Demand, Product } from '../types'
import * as api from '../api'

const Plot = ((PlotComponent as unknown as { default?: typeof PlotComponent }).default ?? PlotComponent) as typeof PlotComponent

interface Props {
  scenarioId: string
}

type ChartType = 'bar' | 'line' | 'area'
type Period = 'day' | 'week' | 'month' | 'quarter'
type Method = 'average' | 'top3'

const DAY = 86400000

const PALETTE = [
  '#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626',
  '#7c3aed', '#db2777', '#0ea5e9', '#65a30d', '#ea580c',
]

// ---------- date / period helpers (UTC, day resolution) ----------

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function quarterOf(ms: number): number {
  return Math.floor(new Date(ms).getUTCMonth() / 3) + 1
}

/** First day (ms) of a demand period. */
function periodStart(periodType: string, year: number, idx: number): number | null {
  if (periodType === 'quarter') {
    const month = [1, 4, 7, 10][idx - 1]
    if (!month) return null
    return Date.UTC(year, month - 1, 1)
  }
  if (periodType === 'month') {
    if (idx < 1 || idx > 12) return null
    return Date.UTC(year, idx - 1, 1)
  }
  return null
}

/** Last day (ms, inclusive) of a demand period. */
function periodEnd(periodType: string, year: number, idx: number): number | null {
  const start = periodStart(periodType, year, idx)
  if (start == null) return null
  const d = new Date(start)
  const next =
    periodType === 'quarter'
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return next - DAY
}

/** Explode a demand row into per-unit due-date ms (mirrors backend explode_due_dates). */
function explodeDueDates(d: Demand): number[] {
  const start = periodStart(d.period_type, d.year, d.period_index)
  const end = periodEnd(d.period_type, d.year, d.period_index)
  if (start == null || end == null) return []
  const n = Math.max(0, d.quantity)
  if (n === 0) return []
  const daysSpan = Math.round((end - start) / DAY)

  if (d.spread_mode === 'start') return Array(n).fill(start)
  if (d.spread_mode === 'end') return Array(n).fill(end)
  // even
  if (n === 1) return [end]
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const frac = (i + 1) / n
    let off = Math.round(frac * (daysSpan + 1) - 1)
    off = Math.max(0, Math.min(daysSpan, off))
    out.push(start + off * DAY)
  }
  return out
}

// ---------- lead-time lookup (worst-case across factories) ----------

function qIndex(year: number, quarter: number): number {
  return year * 4 + (quarter - 1)
}

/** Closest defined (year, quarter) at-or-before target, else any defined value. */
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
    if (idx <= target && (best == null || idx > best.idx)) best = { idx, val: v }
  }
  if (best) return best.val
  return any
}

interface ProductLt {
  name: string
  base: Map<string, number>
  factory: Map<string, number>[]
}

function buildProductLt(products: Product[]): Map<string, ProductLt> {
  const m = new Map<string, ProductLt>()
  for (const p of products) {
    const base = new Map<string, number>()
    for (const lt of p.lead_times) base.set(`${lt.year}-${lt.quarter}`, lt.lead_time_days)
    const byFactory = new Map<string, Map<string, number>>()
    for (const flt of p.factory_lead_times ?? []) {
      let fm = byFactory.get(flt.factory_id)
      if (!fm) {
        fm = new Map()
        byFactory.set(flt.factory_id, fm)
      }
      fm.set(`${flt.year}-${flt.quarter}`, flt.lead_time_days)
    }
    m.set(p.id, { name: p.name, base, factory: [...byFactory.values()] })
  }
  return m
}

/** Worst-case (longest) lead time for the product on the due date. */
function worstCaseLt(plt: ProductLt | undefined, dueMs: number): number {
  if (!plt) return 1
  const year = new Date(dueMs).getUTCFullYear()
  const q = quarterOf(dueMs)
  const candidates: number[] = []
  const base = lookupQuarterly(plt.base, year, q)
  if (base != null) candidates.push(base)
  for (const fm of plt.factory) {
    const v = lookupQuarterly(fm, year, q)
    if (v != null) candidates.push(v)
  }
  return candidates.length ? Math.max(1, Math.max(...candidates)) : 1
}

// ---------- period grouping keys ----------

function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function quarterKey(ms: number): string {
  return `${new Date(ms).getUTCFullYear()}-Q${quarterOf(ms)}`
}

function quarterStartMs(ms: number): number {
  const d = new Date(ms)
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3
  return Date.UTC(d.getUTCFullYear(), qMonth, 1)
}

function nextQuarterStartMs(ms: number): number {
  const d = new Date(quarterStartMs(ms))
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)
}

function serialAt(start: string, k: number): string {
  const m = start.match(/^(.*?)(\d+)$/)
  if (!m) return k === 0 ? start : `${start}-${k}`
  const [, prefix, digits] = m
  const num = BigInt(digits) + BigInt(k)
  return prefix + num.toString().padStart(digits.length, '0')
}

function parseSerialLines(text: string): string[] {
  const lines = text.replace(/\r/g, '\n').split('\n').map((s) => s.trim())
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function serialsForDemand(d: Demand): Array<string | null> {
  if (d.serial_mode === 'sequence' && d.serial_start) {
    return Array.from({ length: Math.max(0, d.quantity) }, (_, i) => serialAt(d.serial_start!, i))
  }
  if (d.serial_mode === 'list') {
    const lines = d.serial_list ? parseSerialLines(d.serial_list) : []
    return Array.from({ length: Math.max(0, d.quantity) }, (_, i) => lines[i] || null)
  }
  return Array.from({ length: Math.max(0, d.quantity) }, () => null)
}

function isoWeekKey(ms: number): string {
  const d = new Date(ms)
  const day = (d.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3))
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// ---------- component ----------

export function BayRequirementsView({ scenarioId }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [demand, setDemand] = useState<Demand[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [period, setPeriod] = useState<Period>('quarter')
  const [method, setMethod] = useState<Method>('average')
  const [totalChartType, setTotalChartType] = useState<ChartType>('area')
  const [productChartType, setProductChartType] = useState<ChartType>('bar')
  const [productFilters, setProductFilters] = useState<Record<string, boolean>>({})
  const [wideGantt, setWideGantt] = useState(false)

  useEffect(() => {
    if (!scenarioId) return
    setLoading(true)
    setError(null)
    Promise.all([api.listProducts(scenarioId), api.listDemand(scenarioId)])
      .then(([p, d]) => {
        setProducts(p)
        setDemand(d)
      })
      .catch((e: unknown) => setError(((e as { message?: string }).message) ?? 'load failed'))
      .finally(() => setLoading(false))
  }, [scenarioId])

  // Explode demand into unit windows and build the daily concurrency series.
  const prep = useMemo(() => {
    if (products.length === 0 || demand.length === 0) return null
    const pLt = buildProductLt(products)
    const pName = new Map(products.map((p) => [p.id, p.name]))

    const units: Array<{ start: number; due: number; product: string; serial: string | null }> = []
    for (const d of demand) {
      const nm = pName.get(d.product_id) ?? '(unknown)'
      const dueDates = explodeDueDates(d)
      const serials = serialsForDemand(d)
      dueDates.forEach((due, i) => {
        const lt = worstCaseLt(pLt.get(d.product_id), due)
        units.push({ start: due - (lt - 1) * DAY, due, product: nm, serial: serials[i] ?? null })
      })
    }
    if (units.length === 0) return null

    let minStart = Infinity
    let maxDue = -Infinity
    for (const u of units) {
      if (u.start < minStart) minStart = u.start
      if (u.due > maxDue) maxDue = u.due
    }
    const numDays = Math.round((maxDue - minStart) / DAY) + 1

    const productNames = [...new Set(units.map((u) => u.product))].sort()
    const totalDiff = new Array(numDays + 1).fill(0)
    const prodDiff = new Map<string, number[]>()
    for (const nm of productNames) prodDiff.set(nm, new Array(numDays + 1).fill(0))

    for (const u of units) {
      const si = Math.round((u.start - minStart) / DAY)
      const di = Math.round((u.due - minStart) / DAY)
      totalDiff[si]++
      totalDiff[di + 1]--
      const pd = prodDiff.get(u.product)!
      pd[si]++
      pd[di + 1]--
    }

    const dates: string[] = []
    const dailyTotals: number[] = []
    const prodDaily = new Map<string, number[]>()
    for (const nm of productNames) prodDaily.set(nm, [])

    let run = 0
    const prodRun = new Map<string, number>()
    for (const nm of productNames) prodRun.set(nm, 0)
    for (let i = 0; i < numDays; i++) {
      run += totalDiff[i]
      dates.push(fmtDate(minStart + i * DAY))
      dailyTotals.push(run)
      for (const nm of productNames) {
        const r = prodRun.get(nm)! + prodDiff.get(nm)![i]
        prodRun.set(nm, r)
        prodDaily.get(nm)!.push(r)
      }
    }

    // Per-quarter peak (the headline "bays needed by quarter").
    const qPeak = new Map<string, number>()
    for (let i = 0; i < numDays; i++) {
      const k = quarterKey(minStart + i * DAY)
      qPeak.set(k, Math.max(qPeak.get(k) ?? 0, dailyTotals[i]))
    }
    const quarterPeaks = [...qPeak.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([quarter, peak]) => ({ quarter, peak }))

    const peak = dailyTotals.length ? Math.max(...dailyTotals) : 0
    return { dates, dailyTotals, productNames, prodDaily, quarterPeaks, peak, minStart, numDays, units }
  }, [products, demand])

  // Initialize product filters when the product set changes.
  useEffect(() => {
    if (!prep) return
    setProductFilters((prev) => {
      const next: Record<string, boolean> = {}
      for (const nm of prep.productNames) next[nm] = prev[nm] ?? true
      return next
    })
  }, [prep])

  // Aggregate to the selected period.
  const agg = useMemo(() => {
    if (!prep) return null
    if (period === 'day') {
      return { x: prep.dates, total: prep.dailyTotals, prod: prep.prodDaily }
    }
    const keyOf = period === 'week' ? isoWeekKey : period === 'month' ? monthKey : quarterKey
    const groups = new Map<string, number[]>()
    for (let i = 0; i < prep.numDays; i++) {
      const k = keyOf(prep.minStart + i * DAY)
      let g = groups.get(k)
      if (!g) {
        g = []
        groups.set(k, g)
      }
      g.push(i)
    }
    const keys = [...groups.keys()].sort()
    const aggVal = (vals: number[]) => {
      if (vals.length === 0) return 0
      if (method === 'top3') {
        const s = [...vals].sort((a, b) => b - a)
        const k = Math.min(3, s.length)
        return s.slice(0, k).reduce((a, b) => a + b, 0) / k
      }
      return vals.reduce((a, b) => a + b, 0) / vals.length
    }
    const total = keys.map((k) => aggVal(groups.get(k)!.map((i) => prep.dailyTotals[i])))
    const prod = new Map<string, number[]>()
    for (const nm of prep.productNames) {
      const arr = prep.prodDaily.get(nm)!
      prod.set(nm, keys.map((k) => aggVal(groups.get(k)!.map((i) => arr[i]))))
    }
    return { x: keys, total, prod }
  }, [prep, period, method])

  const isDay = period === 'day'

  const totalTrace = useMemo(() => {
    if (!agg) return []
    const color = 'rgb(79, 70, 229)'
    const base = { name: 'Bays needed', x: agg.x, y: agg.total }
    if (totalChartType === 'bar') return [{ ...base, type: 'bar', marker: { color } } as Plotly.Data]
    if (totalChartType === 'line')
      return [{ ...base, type: 'scatter', mode: 'lines', line: { color, width: 2 } } as Plotly.Data]
    return [
      {
        ...base,
        type: 'scatter',
        mode: 'lines',
        fill: 'tozeroy',
        line: { color, width: 2 },
        fillcolor: 'rgba(79, 70, 229, 0.18)',
      } as Plotly.Data,
    ]
  }, [agg, totalChartType])

  const productTraces = useMemo(() => {
    if (!agg || !prep) return []
    const shown = prep.productNames.filter((nm) => productFilters[nm] !== false)
    return shown.map((nm, idx) => {
      const color = PALETTE[idx % PALETTE.length]
      const x = agg.x
      const y = agg.prod.get(nm) ?? []
      if (productChartType === 'bar') {
        return { type: 'bar', name: nm, x, y, marker: { color } } as Plotly.Data
      }
      if (productChartType === 'line') {
        return {
          type: 'scatter',
          mode: 'lines',
          name: nm,
          x,
          y,
          line: { color, width: 2 },
        } as Plotly.Data
      }
      return {
        type: 'scatter',
        mode: 'lines',
        name: nm,
        x,
        y,
        fill: 'tonexty',
        line: { color, width: 2 },
        stackgroup: 'one',
      } as Plotly.Data
    })
  }, [agg, prep, productFilters, productChartType])

  const bayGantt = useMemo(() => {
    if (!prep) return null
    const shownUnits = prep.units
      .filter((u) => productFilters[u.product] !== false)
      .sort((a, b) => a.start - b.start || a.due - b.due || a.product.localeCompare(b.product))
    if (shownUnits.length === 0) return null

    const productCounts = new Map<string, number>()
    const usedRows = new Map<string, number>()
    const assigned = shownUnits.map((u) => {
      const n = (productCounts.get(u.product) ?? 0) + 1
      productCounts.set(u.product, n)
      const baseRow = u.serial && u.serial.length > 0 ? u.serial : `${u.product} · Unit ${n}`
      const seen = usedRows.get(baseRow) ?? 0
      usedRows.set(baseRow, seen + 1)
      return { ...u, row: seen === 0 ? baseRow : `${baseRow} (${seen + 1})` }
    })
    const yLabels = assigned.map((u) => u.row)
    const traces = prep.productNames
      .filter((name) => productFilters[name] !== false)
      .flatMap((name, idx) => {
        const units = assigned.filter((u) => u.product === name)
        if (units.length === 0) return []
        return [{
          type: 'bar',
          orientation: 'h',
          name,
          x: units.map((u) => u.due + DAY - u.start),
          y: units.map((u) => u.row),
          base: units.map((u) => u.start),
          text: units.map(() => name),
          textposition: 'inside',
          insidetextanchor: 'start',
          textfont: { color: '#ffffff', size: 10 },
          marker: { color: PALETTE[idx % PALETTE.length], line: { color: 'rgba(255,255,255,0.7)', width: 1 } },
          hovertext: units.map((u) => `${name}<br>${fmtDate(u.start)} → ${fmtDate(u.due)} (${Math.round((u.due - u.start) / DAY) + 1}d)<br>${u.row}`),
          hoverinfo: 'text',
        } as Plotly.Data]
      })

    const minStart = Math.min(...assigned.map((u) => u.start))
    const maxEnd = Math.max(...assigned.map((u) => u.due + DAY))
    const spanStart = quarterStartMs(minStart)
    const spanEnd = nextQuarterStartMs(maxEnd - 1)
    const shapes: Partial<Plotly.Shape>[] = []
    for (let q = spanStart; q <= spanEnd; q = nextQuarterStartMs(q)) {
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: q,
        x1: q,
        y0: 0,
        y1: 1,
        line: { color: '#475569', width: 1.6, dash: 'dash' },
        layer: 'above',
      } as Partial<Plotly.Shape>)
    }
    const numDays = Math.round((maxEnd - minStart) / DAY)
    const diff = new Array(numDays + 1).fill(0)
    for (const u of assigned) {
      const si = Math.round((u.start - minStart) / DAY)
      const di = Math.round((u.due - minStart) / DAY)
      diff[si]++
      diff[di + 1]--
    }
    const dailyCounts: number[] = []
    let running = 0
    for (let i = 0; i < numDays; i++) {
      running += diff[i]
      dailyCounts.push(running)
    }

    const keyOf = period === 'week' ? isoWeekKey : period === 'month' ? monthKey : period === 'quarter' ? quarterKey : (ms: number) => fmtDate(ms)
    const buckets = new Map<string, { first: number; last: number; vals: number[] }>()
    for (let i = 0; i < numDays; i++) {
      const ms = minStart + i * DAY
      const key = keyOf(ms)
      const b = buckets.get(key)
      if (b) {
        b.last = ms
        b.vals.push(dailyCounts[i])
      } else {
        buckets.set(key, { first: ms, last: ms, vals: [dailyCounts[i]] })
      }
    }
    const aggregateVals = (vals: number[]) => {
      if (vals.length === 0) return 0
      if (period !== 'day' && method === 'top3') {
        const sorted = [...vals].sort((a, b) => b - a)
        const n = Math.min(3, sorted.length)
        return sorted.slice(0, n).reduce((a, b) => a + b, 0) / n
      }
      return vals.reduce((a, b) => a + b, 0) / vals.length
    }
    const countTicks = [...buckets.entries()]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([label, b]) => ({
        value: b.first + (b.last - b.first) / 2,
        text: `${aggregateVals(b.vals).toFixed(0)}`,
        label,
      }))
    const topAxisTrace = {
      type: 'scatter',
      mode: 'markers',
      xaxis: 'x2',
      yaxis: 'y2',
      x: countTicks.map((t) => t.value),
      y: countTicks.map(() => 0),
      marker: { opacity: 0, size: 1 },
      hoverinfo: 'skip',
      showlegend: false,
    } as Plotly.Data
    return { traces: [topAxisTrace, ...traces], yLabels, shapes, annotations: [], countTicks, peak: Math.max(...dailyCounts), bucketCount: countTicks.length }
  }, [prep, productFilters, period, method])

  const xTitle = isDay ? 'Date' : period === 'week' ? 'Week' : period === 'month' ? 'Month' : 'Quarter'

  if (loading) return <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>
  if (error) return <div className="text-sm text-rose-600">{error}</div>
  if (!prep || !agg) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500 text-sm">
        Add products (with lead times) and demand to see bay requirements.
      </div>
    )
  }

  const peakQuarter = prep.quarterPeaks.reduce(
    (best, q) => (q.peak > best.peak ? q : best),
    prep.quarterPeaks[0] ?? { quarter: '—', peak: 0 },
  )

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
          <BarChart3 className="w-5 h-5 text-indigo-600" />
          Bay requirements
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          How many bays are needed to build all demand <strong>on time</strong>, from demand by
          quarter × the <strong>worst-case (longest)</strong> lead time per product. Uncapacitated —
          independent of how many bays you&apos;ve provisioned.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Period</label>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
            >
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
              <option value="quarter">Quarterly</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Aggregation</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as Method)}
              disabled={isDay}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white disabled:opacity-50"
            >
              <option value="average">Average</option>
              <option value="top3">Top 3 average (peak-ish)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="bg-indigo-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-indigo-600">{prep.peak}</div>
            <div className="text-sm text-slate-600">Peak bays needed</div>
          </div>
          <div className="bg-emerald-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-emerald-600">{peakQuarter.quarter}</div>
            <div className="text-sm text-slate-600">Busiest quarter ({peakQuarter.peak} bays)</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-slate-700">{prep.productNames.length}</div>
            <div className="text-sm text-slate-600">Products</div>
          </div>
        </div>
      </div>

      <ChartCard
        title="Bays needed over time"
        chartType={totalChartType}
        onChartType={setTotalChartType}
      >
        <Plot
          data={totalTrace}
          layout={{
            height: 320,
            xaxis: { title: { text: xTitle }, type: isDay ? 'date' : undefined },
            yaxis: { title: { text: 'Bays needed' } },
            hovermode: 'x unified',
            margin: { t: 20, r: 20, l: 50, b: 50 },
          }}
          config={{ responsive: true, displayModeBar: false }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </ChartCard>

      <div className={`${wideGantt ? 'relative left-1/2 -translate-x-1/2 w-[calc(100vw-3rem)]' : 'w-full'} rounded-lg border border-slate-200 bg-white p-6`}>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <h3 className="font-medium text-slate-700">Bay requirements Gantt</h3>
            <p className="text-xs text-slate-500 mt-1">
              One row per theoretical unit build window. Rows use serial numbers when provided; top numbers show bays needed over time on the same timeline.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {bayGantt && (
              <div className="text-sm text-slate-600">
                Peak active: <span className="font-semibold text-slate-800">{bayGantt.peak}</span> units
              </div>
            )}
            <button
              type="button"
              className="px-2.5 py-1 border border-slate-300 rounded text-sm text-slate-700 bg-white hover:bg-slate-50"
              onClick={() => setWideGantt((v) => !v)}
            >
              {wideGantt ? 'Compact' : 'Wide'}
            </button>
          </div>
        </div>
        {bayGantt ? (
          <div className={wideGantt ? 'w-full overflow-x-auto pb-2' : 'w-full'}>
            <Plot
              data={bayGantt.traces}
              layout={{
                autosize: true,
                height: Math.max(120, bayGantt.yLabels.length * 28 + 86),
                barmode: 'overlay',
                bargap: 0.18,
                shapes: bayGantt.shapes,
                annotations: bayGantt.annotations,
                hovermode: 'closest',
                showlegend: false,
                xaxis: { title: { text: 'Date' }, type: 'date', showgrid: false, dtick: 'M3', tickformat: "%b '%y" },
                xaxis2: {
                  title: { text: '' },
                  type: 'date',
                  overlaying: 'x',
                  side: 'top',
                  tickmode: 'array',
                  tickvals: bayGantt.countTicks.map((t) => t.value),
                  ticktext: bayGantt.countTicks.map((t) => t.text),
                  tickfont: { size: 12, color: '#1e293b' },
                  showgrid: false,
                  ticks: 'outside',
                  automargin: false,
                  matches: 'x',
                  showline: false,
                },
                yaxis: {
                  title: { text: 'Units' },
                  type: 'category',
                  categoryorder: 'array',
                  categoryarray: bayGantt.yLabels,
                  range: [bayGantt.yLabels.length - 0.5, -0.5],
                  automargin: true,
                },
                yaxis2: {
                  overlaying: 'y',
                  visible: false,
                  fixedrange: true,
                  range: [0, 1],
                },
                margin: { t: 34, r: 20, l: 20, b: 28 },
              }}
              config={{ responsive: true, displayModeBar: false, displaylogo: false }}
              style={{ width: wideGantt ? `max(100%, ${Math.max(1000, bayGantt.bucketCount * 120)}px)` : '100%' }}
              useResizeHandler
            />
          </div>
        ) : (
          <div className="text-sm text-slate-500 text-center py-6">No products selected.</div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="font-medium flex items-center gap-2 text-slate-700">
            <Layers className="w-4 h-4" />
            Bays needed by product
          </h3>
          <ChartTypeToggle value={productChartType} onChange={setProductChartType} />
        </div>

        <div className="mb-4 p-3 bg-slate-50 rounded-lg">
          <div className="text-xs font-medium text-slate-600 mb-2 flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5" />
            Show products
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {prep.productNames.map((nm) => (
              <label
                key={nm}
                className="flex items-center gap-2 bg-white px-2 py-1.5 rounded border border-slate-200 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={productFilters[nm] !== false}
                  onChange={() =>
                    setProductFilters((prev) => ({ ...prev, [nm]: prev[nm] === false }))
                  }
                />
                <span className="truncate">{nm}</span>
              </label>
            ))}
          </div>
        </div>

        {productTraces.length > 0 ? (
          <Plot
            data={productTraces}
            layout={{
              height: 400,
              barmode: productChartType === 'bar' ? 'stack' : undefined,
              xaxis: { title: { text: xTitle }, type: isDay ? 'date' : undefined },
              yaxis: { title: { text: 'Bays needed' } },
              legend: { orientation: 'h', y: -0.18 },
              hovermode: 'x unified',
              margin: { t: 20, r: 20, l: 50, b: 50 },
            }}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        ) : (
          <div className="text-sm text-slate-500 text-center py-6">No products selected.</div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="font-medium text-slate-700 mb-1">Peak bays needed by quarter</h3>
        <p className="text-xs text-slate-500 mb-3">
          The maximum number of units in build at once during each quarter — the minimum bays that
          quarter requires to keep all demand on time.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-1 pr-3 font-medium">Quarter</th>
              <th className="py-1 font-medium text-right">Peak bays needed</th>
            </tr>
          </thead>
          <tbody>
            {prep.quarterPeaks.map((q) => (
              <tr key={q.quarter} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 whitespace-nowrap">{q.quarter}</td>
                <td className="py-1.5 text-right font-medium">{q.peak}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- small UI bits ----------

function ChartTypeToggle({
  value,
  onChange,
}: {
  value: ChartType
  onChange: (v: ChartType) => void
}) {
  const btn = (t: ChartType, Icon: typeof BarChart2, title: string) => (
    <button
      onClick={() => onChange(t)}
      title={title}
      className={
        'p-1.5 rounded transition-colors ' +
        (value === t ? 'bg-white shadow text-indigo-600' : 'text-slate-500 hover:text-slate-700')
      }
    >
      <Icon className="w-4 h-4" />
    </button>
  )
  return (
    <div className="flex items-center gap-1 bg-slate-100 rounded p-1">
      {btn('bar', BarChart2, 'Bar')}
      {btn('line', LineChart, 'Line')}
      {btn('area', AreaChart, 'Area')}
    </div>
  )
}

function ChartCard({
  title,
  chartType,
  onChartType,
  children,
}: {
  title: string
  chartType: ChartType
  onChartType: (v: ChartType) => void
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-slate-700">{title}</h3>
        <ChartTypeToggle value={chartType} onChange={onChartType} />
      </div>
      {children}
    </div>
  )
}

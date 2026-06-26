import { useMemo, useState } from 'react'
import PlotComponent from 'react-plotly.js'
import type { Factory, Product, RunResult, ScheduledUnit } from '../types'

const Plot = ((PlotComponent as unknown as { default?: typeof PlotComponent }).default ?? PlotComponent) as typeof PlotComponent

interface Props {
  result: RunResult
  factories: Factory[]
  products: Product[]
}

const DAY = 86400000

const QUARTER_PALETTE = ['#dc2626', '#16a34a', '#eab308', '#2563eb']

const IDLE_COLOR = '#cbd5e1' // gaps between products (true idle)
const OPEN_COLOR = '#86efac' // open/unused bay time — highlighted green

/** Blend a hex color toward white by `amt` (0..1) — used to shade late units. */
function lighten(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const mix = (c: number) => Math.round(c + (255 - c) * amt)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

/** Get the normal + late color for a shipping quarter number (1-4). */
function quarterColor(quarter: number): { normal: string; late: string } {
  const normal = QUARTER_PALETTE[(quarter - 1) % 4]
  const late = lighten(normal, 0.5)
  return { normal, late }
}

/** Quarter key from a date string "YYYY-MM-DD", e.g. "2026-Q3". */
function shipQuarterKey(dueDate: string): string {
  const year = dueDate.slice(0, 4)
  const month = parseInt(dueDate.slice(5, 7), 10)
  const q = Math.floor((month - 1) / 3) + 1
  return `${year}-Q${q}`
}

/** Friendly quarter label from a quarter key "2026-Q3" -> "Q3 '26". */
function shipQuarterLabel(key: string): string {
  const yy = key.slice(2, 4)
  const qPart = key.slice(5) // "Q3"
  return `${qPart} '${yy}`
}

function parseMs(d: string): number {
  // dates are day-resolution "YYYY-MM-DD" (parsed as UTC midnight)
  return Date.parse(d)
}

function fmtMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** ms (UTC) of the first day of the quarter that contains `ms`. */
function quarterStartMs(ms: number): number {
  const d = new Date(ms)
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3 // 0, 3, 6, 9
  return Date.UTC(d.getUTCFullYear(), qMonth, 1)
}

/** ms (UTC) of the first day of the quarter *after* the one containing `ms`. */
function nextQuarterStartMs(ms: number): number {
  const d = new Date(quarterStartMs(ms))
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)
}

/** Quarter label for the quarter starting at `ms`, e.g. "Q3 '26". */
function quarterLabel(ms: number): string {
  const d = new Date(ms)
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  const yy = String(d.getUTCFullYear()).slice(2)
  return `Q${q} '${yy}`
}

/** Provisioned bays for a factory in a specific (year, quarter): a per-quarter
 *  override if present, else the baseline bay count. */
function effectiveBays(f: Factory, year: number, quarter: number): number {
  const override = f.bay_counts.find((bc) => bc.year === year && bc.quarter === quarter)
  return override ? override.bays : f.bays
}

interface BayNeed {
  factoryId: string
  factoryName: string
  label: string // "Q3 '26"
  needed: number // peak simultaneous units = theoretical min bays to stay on time
  provisioned: number
  free: number
}

/**
 * Compact bar label: quarter + 2-digit year (from the due date) + first 2
 * letters of the product name. e.g. due 2026-08-15, "Widget" -> "Q3'26 Wi".
 */
function shortLabel(dueDate: string, productName: string): string {
  const month = parseInt(dueDate.slice(5, 7), 10) // 1..12
  const q = Math.floor((month - 1) / 3) + 1
  const yy = dueDate.slice(2, 4)
  const ini = productName.replace(/\s+/g, '').slice(0, 2)
  return `Q${q}'${yy} ${ini}`
}

/** Effective number of bay rows to draw for a factory. */
function bayCountFor(f: Factory, units: ScheduledUnit[]): number {
  let n = f.bays
  for (const bc of f.bay_counts) n = Math.max(n, bc.bays)
  for (const u of units) {
    if (u.factory_id === f.id && u.bay_index != null) n = Math.max(n, u.bay_index + 1)
  }
  return Math.max(n, 1)
}

interface FactoryStat {
  id: string
  name: string
  bays: number
  busyDays: number
  idleDays: number // gaps between products only
  openDays: number // before first / after last product (bay open)
  utilization: number // 0..1, busy / (busy + idle)
}

export function GanttView({ result, factories, products }: Props) {
  const multi = factories.length > 1
  const [view, setView] = useState<string>(() => (multi ? 'all' : factories[0]?.id ?? ''))
  const [showIdle, setShowIdle] = useState(false)
  const [scenario, setScenario] = useState('current')
  const [chartMode, setChartMode] = useState<'merged' | 'split'>('merged')
  const [wideCharts, setWideCharts] = useState(false)
  const alternatives = result.alternatives ?? []
  const selectedAlt = alternatives.find((a) => a.kind === scenario)
  const activeUnits = selectedAlt?.units ?? result.units

  const productNames = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach((p) => m.set(p.id, p.name))
    return m
  }, [products])

  const { charts, stats } = useMemo(() => {
    const shipped = activeUnits.filter((u) => u.status === 'shipped' && u.factory_id != null)
    const selectedFactories = view === 'all' ? factories : factories.filter((f) => f.id === view)
    const chartFactoryGroups = chartMode === 'split' && view === 'all'
      ? selectedFactories.map((f) => [f])
      : [selectedFactories]

    const buildChart = (shownFactories: Factory[], chartIndex: number) => {
      const rowLabels: string[] = []
      const rowKey = (factoryId: string, bay: number) => `${factoryId}#${bay}`
      const labelOf = new Map<string, string>()
      const merged = shownFactories.length > 1
      for (const f of shownFactories) {
        const nbays = bayCountFor(f, shipped)
        for (let b = 0; b < nbays; b++) {
          const label = merged ? `${f.name} · Bay ${b + 1}` : `Bay ${b + 1}`
          rowLabels.push(label)
          labelOf.set(rowKey(f.id, b), label)
        }
      }

      const traces: Plotly.Data[] = []
      const stats: FactoryStat[] = []
      const quarterLegendShown = new Set<string>()

      for (const f of shownFactories) {
        const fUnits = shipped.filter((u) => u.factory_id === f.id)
        const quarterGroups = new Map<string, ScheduledUnit[]>()
        for (const u of fUnits) {
          const qk = shipQuarterKey(u.due_date)
          const arr = quarterGroups.get(qk)
          if (arr) arr.push(u)
          else quarterGroups.set(qk, [u])
        }

        const sortedQKeys = [...quarterGroups.keys()].sort()
        for (const qk of sortedQKeys) {
          const qUnits = quarterGroups.get(qk)!
          const qNum = parseInt(qk.slice(-1), 10)
          const { normal: normalColor, late: lateColor } = quarterColor(qNum)
          const xs: number[] = []
          const ys: string[] = []
          const bases: number[] = []
          const labels: string[] = []
          const hovers: string[] = []
          const colors: string[] = []

          for (const u of qUnits) {
            const s = parseMs(u.required_start)
            const e = parseMs(u.due_date) + DAY
            const label = labelOf.get(rowKey(f.id, u.bay_index ?? 0))
            if (label == null) continue
            const nm = productNames.get(u.product_id) ?? u.product_id
            const utid = u.serial && u.serial.length > 0 ? u.serial : shortLabel(u.due_date, nm)
            xs.push(e - s)
            ys.push(label)
            bases.push(s)
            labels.push(utid)
            colors.push(u.is_late ? lateColor : normalColor)
            const serialLine = u.serial ? `UTID ${u.serial}<br>` : ''
            const lateLine = u.is_late ? ' <b>(rolled out / late)</b>' : ''
            hovers.push(
              `${serialLine}<b>${nm}</b>${lateLine}<br>${f.name} · ${shipQuarterLabel(qk)} · Bay ${(u.bay_index ?? 0) + 1}<br>${u.required_start} → ${u.due_date} (${Math.round(
                (e - s) / DAY,
              )}d)`,
            )
          }

          const showQuarterLegend = !quarterLegendShown.has(qk)
          quarterLegendShown.add(qk)
          traces.push({
            type: 'bar',
            orientation: 'h',
            name: shipQuarterLabel(qk),
            x: xs,
            y: ys,
            base: bases,
            text: labels,
            textposition: 'inside',
            insidetextanchor: 'start',
            textfont: { color: '#ffffff', size: 10 },
            constraintext: 'none',
            cliponaxis: false,
            marker: { color: colors, line: { color: 'rgba(255,255,255,0.6)', width: 1 } },
            hovertext: hovers,
            hoverinfo: 'text',
            legendgroup: qk,
            showlegend: showQuarterLegend,
          } as Plotly.Data)
        }

        let busyMs = 0
        let idleMs = 0
        let openMs = 0
        const idleXs: number[] = []
        const idleYs: string[] = []
        const idleBases: number[] = []
        const idleHovers: string[] = []
        const openXs: number[] = []
        const openYs: string[] = []
        const openBases: number[] = []
        const openHovers: string[] = []

        if (fUnits.length > 0) {
          const winStart = Math.min(...fUnits.map((u) => parseMs(u.required_start)))
          const winEnd = Math.max(...fUnits.map((u) => parseMs(u.due_date) + DAY))
          const nbays = bayCountFor(f, shipped)
          const pushSpan = (
            kind: 'idle' | 'open',
            label: string,
            b: number,
            gs: number,
            ge: number,
          ) => {
            if (ge <= gs) return
            const span = ge - gs
            const hov = `${kind === 'idle' ? 'Idle' : 'Bay open'} · ${f.name} · Bay ${
              b + 1
            }<br>${fmtMs(gs)} → ${fmtMs(ge)} (${Math.round(span / DAY)}d)`
            if (kind === 'idle') {
              idleMs += span
              idleXs.push(span)
              idleYs.push(label)
              idleBases.push(gs)
              idleHovers.push(hov)
            } else {
              openMs += span
              openXs.push(span)
              openYs.push(label)
              openBases.push(gs)
              openHovers.push(hov)
            }
          }

          for (let b = 0; b < nbays; b++) {
            const label = labelOf.get(rowKey(f.id, b))
            if (label == null) continue
            const occ = fUnits
              .filter((u) => (u.bay_index ?? 0) === b)
              .map((u) => ({ s: parseMs(u.required_start), e: parseMs(u.due_date) + DAY }))
              .sort((a, z) => a.s - z.s)

            if (occ.length === 0) {
              pushSpan('open', label, b, winStart, winEnd)
              continue
            }
            for (const o of occ) busyMs += o.e - o.s

            let cursor = occ[0].e
            for (let k = 1; k < occ.length; k++) {
              pushSpan('idle', label, b, cursor, occ[k].s)
              cursor = Math.max(cursor, occ[k].e)
            }
            pushSpan('open', label, b, cursor, winEnd)
          }
        }

        if (showIdle) {
          if (openXs.length > 0) {
            traces.push({
              type: 'bar',
              orientation: 'h',
              name: 'Bay open',
              x: openXs,
              y: openYs,
              base: openBases,
              marker: { color: OPEN_COLOR },
              hovertext: openHovers,
              hoverinfo: 'text',
              legendgroup: 'open',
              showlegend: stats.length === 0,
              opacity: 0.9,
            } as Plotly.Data)
          }
          if (idleXs.length > 0) {
            traces.push({
              type: 'bar',
              orientation: 'h',
              name: 'Idle',
              x: idleXs,
              y: idleYs,
              base: idleBases,
              marker: { color: IDLE_COLOR },
              hovertext: idleHovers,
              hoverinfo: 'text',
              legendgroup: 'idle',
              showlegend: stats.length === 0,
              opacity: 0.9,
            } as Plotly.Data)
          }
        }

        const busyDays = busyMs / DAY
        const idleDays = idleMs / DAY
        const total = busyDays + idleDays
        stats.push({
          id: f.id,
          name: f.name,
          bays: bayCountFor(f, shipped),
          busyDays,
          idleDays,
          openDays: openMs / DAY,
          utilization: total > 0 ? busyDays / total : 0,
        })
      }

      const shownUnits = shipped.filter((u) =>
        shownFactories.some((f) => f.id === u.factory_id),
      )
      const quarterShapes: Partial<Plotly.Shape>[] = []
      const quarterAnnotations: Partial<Plotly.Annotations>[] = []
      let bucketCount = 1

      if (shownUnits.length > 0) {
        const rawStart = Math.min(...shownUnits.map((u) => parseMs(u.required_start)))
        const rawEnd = Math.max(...shownUnits.map((u) => parseMs(u.due_date) + DAY))
        const spanStart = quarterStartMs(rawStart)
        const spanEnd = nextQuarterStartMs(rawEnd - 1)
        bucketCount = Math.max(1, Math.ceil((spanEnd - spanStart) / (91 * DAY)))

        for (let q = spanStart; q <= spanEnd; q = nextQuarterStartMs(q)) {
          quarterShapes.push({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: q,
            x1: q,
            y0: 0,
            y1: 1,
            line: {
              color: '#475569',
              width: 1.6,
              dash: 'dash',
            },
            layer: 'above',
          } as Partial<Plotly.Shape>)
        }

        for (let q = spanStart; q < spanEnd; q = nextQuarterStartMs(q)) {
          const qEnd = nextQuarterStartMs(q)
          quarterAnnotations.push({
            xref: 'x',
            yref: 'paper',
            x: q + (qEnd - q) / 2,
            y: 1.02,
            yanchor: 'bottom',
            text: quarterLabel(q),
            showarrow: false,
            font: { size: 10, color: '#64748b' },
          } as Partial<Plotly.Annotations>)
        }
      }

      const shapes = [...quarterShapes]
      if (merged) {
        let rowIdx = 0
        for (let i = 0; i < shownFactories.length - 1; i++) {
          rowIdx += bayCountFor(shownFactories[i], shipped)
          const y = rowIdx - 0.5
          shapes.push({
            type: 'line',
            xref: 'paper',
            yref: 'y',
            x0: 0,
            x1: 1,
            y0: y,
            y1: y,
            line: {
              color: '#334155',
              width: 3,
            },
            layer: 'above',
          } as Partial<Plotly.Shape>)
        }
      }

      const layout: Partial<Plotly.Layout> = {
        autosize: true,
        barmode: 'overlay',
        bargap: 0.25,
        dragmode: 'pan',
        shapes,
        annotations: quarterAnnotations,
        xaxis: {
          type: 'date',
          title: { text: 'Date' },
          showgrid: false,
          dtick: 'M3',
          tickformat: "%b '%y",
        },
        yaxis: {
          title: { text: merged ? 'Factory · Bay' : 'Bays' },
          type: 'category',
          categoryorder: 'array',
          categoryarray: rowLabels,
          autorange: 'reversed',
          automargin: true,
        },
        margin: { l: 20, r: 20, t: 28, b: 50 },
        legend: { orientation: 'h', y: -0.18 },
        height: Math.max(220, rowLabels.length * 30 + 145),
      }

      return {
        key: shownFactories.map((f) => f.id).join('-') || `chart-${chartIndex}`,
        title: merged ? 'All factories' : shownFactories[0]?.name ?? 'Factory',
        data: traces,
        layout,
        stats,
        width: Math.max(1000, bucketCount * 180),
      }
    }

    const charts = chartFactoryGroups.map((group, i) => buildChart(group, i))
    return { charts, stats: charts.flatMap((chart) => chart.stats) }
  }, [view, chartMode, showIdle, factories, productNames, activeUnits])

  // Bays needed (theoretical floor = peak simultaneous demand) vs provisioned,
  // per factory per quarter. Mode-independent: it's the minimum bays required to
  // host that factory's units on their windows without overlap.
  const bayNeeds = useMemo<BayNeed[]>(() => {
    const shipped = activeUnits.filter((u) => u.status === 'shipped' && u.factory_id != null)
    if (shipped.length === 0) return []

    // Overall quarter span across all shipped units.
    let spanStart = Infinity
    let spanEnd = -Infinity
    for (const u of shipped) {
      spanStart = Math.min(spanStart, parseMs(u.required_start))
      spanEnd = Math.max(spanEnd, parseMs(u.due_date) + DAY)
    }
    spanStart = quarterStartMs(spanStart)
    spanEnd = nextQuarterStartMs(spanEnd - 1)

    const rows: BayNeed[] = []
    for (const f of factories) {
      const fUnits = shipped
        .filter((u) => u.factory_id === f.id)
        .map((u) => ({ s: parseMs(u.required_start), e: parseMs(u.due_date) + DAY }))
      for (let q = spanStart; q < spanEnd; q = nextQuarterStartMs(q)) {
        const qStart = q
        const qEnd = nextQuarterStartMs(q)
        // Peak overlap within this quarter (windows clipped to the quarter).
        const events: Array<[number, number]> = []
        for (const w of fUnits) {
          const s = Math.max(w.s, qStart)
          const e = Math.min(w.e, qEnd)
          if (e > s) {
            events.push([s, 1])
            events.push([e, -1])
          }
        }
        if (events.length === 0) continue // factory idle this quarter — skip row
        events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
        let cur = 0
        let peak = 0
        for (const [, delta] of events) {
          cur += delta
          if (cur > peak) peak = cur
        }
        const d = new Date(qStart)
        const provisioned = effectiveBays(f, d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) + 1)
        rows.push({
          factoryId: f.id,
          factoryName: f.name,
          label: quarterLabel(qStart),
          needed: peak,
          provisioned,
          free: provisioned - peak,
        })
      }
    }
    return rows
  }, [factories, activeUnits])

  if (factories.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-slate-500 text-sm">
        No factories defined.
      </div>
    )
  }

  const overall: FactoryStat | null =
    stats.length > 0
      ? {
          id: 'overall',
          name: 'Overall',
          bays: stats.reduce((s, x) => s + x.bays, 0),
          busyDays: stats.reduce((s, x) => s + x.busyDays, 0),
          idleDays: stats.reduce((s, x) => s + x.idleDays, 0),
          openDays: stats.reduce((s, x) => s + x.openDays, 0),
          utilization: 0,
        }
      : null
  if (overall) {
    const tot = overall.busyDays + overall.idleDays
    overall.utilization = tot > 0 ? overall.busyDays / tot : 0
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-600">Scenario:</span>
          <select
            className="border border-slate-300 rounded px-2 py-1 bg-white"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            <option value="current">Current run</option>
            {alternatives.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.label}
              </option>
            ))}
          </select>
          {selectedAlt && (
            <span className="text-xs text-slate-500">
              {selectedAlt.description}: {selectedAlt.shipped_on_time}/{selectedAlt.total_demand}{' '}
              on time
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-600">View:</span>
          <select
            className="border border-slate-300 rounded px-2 py-1 bg-white"
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            {multi && <option value="all">All factories</option>}
            {factories.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.bays} bays)
              </option>
            ))}
          </select>
        </div>
        {multi && view === 'all' && (
          <div className="flex items-center gap-2">
            <span className="text-slate-600">Gantt:</span>
            <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
              <button
                type="button"
                className={`px-2.5 py-1 ${chartMode === 'merged' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}
                onClick={() => setChartMode('merged')}
              >
                Merged
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 border-l border-slate-300 ${chartMode === 'split' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}
                onClick={() => setChartMode('split')}
              >
                Split by factory
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="px-2.5 py-1 border border-slate-300 rounded text-sm text-slate-700 bg-white hover:bg-slate-50"
          onClick={() => setWideCharts((v) => !v)}
        >
          {wideCharts ? 'Compact' : 'Wide'}
        </button>
        <label className="flex items-center gap-2 text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showIdle}
            onChange={(e) => setShowIdle(e.target.checked)}
          />
          Highlight idle / open
        </label>
        <span className="text-xs text-slate-500">
          Colors are by shipping quarter across all factories, recycled yearly.{' '}
          <span className="text-slate-400">Dimmed tint</span> = rolled-out (late). Gaps{' '}
          <em>between</em> products are <strong>idle</strong>;{' '}
          <strong className="text-green-600">green</strong> = open: after a bay&apos;s last unit
          ships (and entirely empty bays). Time before the first unit is ignored.
        </span>
      </div>

      <div className={`${wideCharts ? 'relative left-1/2 -translate-x-1/2 w-[calc(100vw-3rem)]' : 'w-full'} space-y-3`}>
        {charts.map((chart) => (
          <div key={chart.key} className="rounded-lg border border-slate-200 bg-white p-3">
            {charts.length > 1 && (
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-slate-700">{chart.title}</h4>
                <span className="text-xs text-slate-500">
                  {wideCharts ? 'Scroll horizontally for longer timelines' : 'Compact width'}
                </span>
              </div>
            )}
            <div className={wideCharts ? 'w-full overflow-x-auto pb-2' : 'w-full'}>
              <Plot
                key={`${chart.key}-${wideCharts ? 'wide' : 'compact'}`}
                data={chart.data}
                layout={chart.layout}
                config={{ displayModeBar: false, displaylogo: false, responsive: true }}
                style={{ width: wideCharts ? `max(100%, ${chart.width}px)` : '100%' }}
                useResizeHandler
              />
            </div>
          </div>
        ))}
      </div>

      {bayNeeds.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-1">Bays needed vs. provisioned</h4>
          <p className="text-xs text-slate-500 mb-3">
            <strong>Needed</strong> is the peak number of units in build at once that quarter — the
            minimum bays required to keep everything on time (independent of the assignment mode).
            <strong className="text-green-600"> Free</strong> bays are provisioned but not needed and
            could be closed for that quarter.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-1 pr-3 font-medium">Factory</th>
                <th className="py-1 pr-3 font-medium">Quarter</th>
                <th className="py-1 pr-3 font-medium text-right">Needed</th>
                <th className="py-1 pr-3 font-medium text-right">Provisioned</th>
                <th className="py-1 font-medium text-right">Free</th>
              </tr>
            </thead>
            <tbody>
              {bayNeeds.map((b) => (
                <tr key={`${b.factoryId}-${b.label}`} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                      style={{ background: '#64748b' }}
                    />
                    {b.factoryName}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{b.label}</td>
                  <td className="py-1.5 pr-3 text-right font-medium">{b.needed}</td>
                  <td className="py-1.5 pr-3 text-right text-slate-500">{b.provisioned}</td>
                  <td
                    className={`py-1.5 text-right font-medium ${
                      b.free > 0 ? 'text-green-600' : b.free < 0 ? 'text-rose-600' : 'text-slate-400'
                    }`}
                  >
                    {b.free > 0 ? `${b.free} free` : b.free < 0 ? `${-b.free} short` : '0'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-1">Capacity utilization</h4>
          <p className="text-xs text-slate-500 mb-3">
            <strong>Idle</strong> bay-days are gaps <em>between</em> products — the only truly
            unused capacity within a bay&apos;s run. Time before a bay&apos;s first product is
            ignored; time after its last product ships (and entirely empty bays) is{' '}
            <strong>bay open</strong>, not idle. Utilization = busy ÷ (busy + idle).
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-1 pr-3 font-medium">Factory</th>
                <th className="py-1 pr-3 font-medium text-right">Bays</th>
                <th className="py-1 pr-3 font-medium text-right">Busy bay-days</th>
                <th className="py-1 pr-3 font-medium text-right">Idle bay-days</th>
                <th className="py-1 pr-3 font-medium text-right">Bay open</th>
                <th className="py-1 font-medium text-right">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                      style={{ background: '#64748b' }}
                    />
                    {s.name}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{s.bays}</td>
                  <td className="py-1.5 pr-3 text-right">{Math.round(s.busyDays)}</td>
                  <td className="py-1.5 pr-3 text-right">{Math.round(s.idleDays)}</td>
                  <td className="py-1.5 pr-3 text-right text-slate-400">
                    {Math.round(s.openDays)}
                  </td>
                  <td className="py-1.5 text-right font-medium">
                    {(s.utilization * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
              {overall && stats.length > 1 && (
                <tr className="font-semibold">
                  <td className="py-1.5 pr-3">{overall.name}</td>
                  <td className="py-1.5 pr-3 text-right">{overall.bays}</td>
                  <td className="py-1.5 pr-3 text-right">{Math.round(overall.busyDays)}</td>
                  <td className="py-1.5 pr-3 text-right">{Math.round(overall.idleDays)}</td>
                  <td className="py-1.5 pr-3 text-right text-slate-400">
                    {Math.round(overall.openDays)}
                  </td>
                  <td className="py-1.5 text-right">{(overall.utilization * 100).toFixed(0)}%</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

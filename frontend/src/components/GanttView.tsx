import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check, ChevronDown } from 'lucide-react'
import PlotComponent from 'react-plotly.js'
import * as api from '../api'
import type { Factory, Product, RunResult, ScheduleRun, ScheduledUnit } from '../types'

const Plot = ((PlotComponent as unknown as { default?: typeof PlotComponent }).default ?? PlotComponent) as typeof PlotComponent

interface Props {
  result: RunResult
  factories: Factory[]
  products: Product[]
}

type UtidSort = 'ship' | 'start'

const DAY = 86400000

const QUARTER_PALETTE = ['#dc2626', '#16a34a', '#eab308', '#2563eb']
const FACTORY_PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2']

const IDLE_COLOR = '#cbd5e1' // gaps between products (true idle)
const OPEN_COLOR = '#86efac' // open/unused bay time — highlighted green
const LATE_ANCHOR_COLOR = '#dc2626'

function isLateAnchored(u: ScheduledUnit): boolean {
  return Boolean(u.is_anchored && (u.is_late || (u.orig_due_date && u.due_date > u.orig_due_date)))
}

function anchorHoverDetails(u: ScheduledUnit): string {
  if (!u.is_anchored) return ''
  const target = u.orig_due_date ?? u.due_date
  const missed = isLateAnchored(u) ? '<br><b>MISSED DUE DATE</b>' : ''
  return `<br>Anchored target due: ${target}<br>Scheduled finish: ${u.due_date}${missed}`
}

function quarterColor(quarter: number): string {
  return QUARTER_PALETTE[(quarter - 1) % 4]
}

function factoryColor(factories: Factory[], factoryId: string | null): string {
  const idx = factories.findIndex((f) => f.id === factoryId)
  return FACTORY_PALETTE[(idx >= 0 ? idx : 0) % FACTORY_PALETTE.length]
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

function quarterMarkers(startMs: number, endMs: number): number[] {
  const markers: number[] = []
  for (let q = quarterStartMs(startMs); q <= endMs; q = nextQuarterStartMs(q)) markers.push(q)
  return markers
}

function runOptionLabel(run: ScheduleRun): string {
  const d = new Date(run.run_at)
  const when = Number.isNaN(d.getTime()) ? run.run_at : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${when} — ${run.shipped_on_time} scheduled, ${run.unshippable} unscheduled`
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
  const showIdle = false
  const [runSelection, setRunSelection] = useState('current')
  const [savedRuns, setSavedRuns] = useState<ScheduleRun[]>([])
  const [selectedRunResult, setSelectedRunResult] = useState<RunResult | null>(null)
  const [runHistoryError, setRunHistoryError] = useState<string | null>(null)
  const [chartMode, setChartMode] = useState<'merged' | 'split'>('merged')
  const [wideCharts, setWideCharts] = useState(true)
  const [chartRevision, setChartRevision] = useState(0)
  const [utidSort, setUtidSort] = useState<UtidSort>('ship')
  const [factoryGanttOpen, setFactoryGanttOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [utidPlotMargins, setUtidPlotMargins] = useState({ left: 140, right: 20 })
  const utidTopScrollRef = useRef<HTMLDivElement>(null)
  const utidBodyScrollRef = useRef<HTMLDivElement>(null)
  const displayedResult = selectedRunResult ?? result
  const alternatives = displayedResult.alternatives ?? []
  const selectedAlt = runSelection.startsWith('alt:')
    ? alternatives.find((a) => a.kind === runSelection.slice(4))
    : undefined
  const activeUnits = selectedAlt?.units ?? displayedResult.units

  const productNames = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach((p) => m.set(p.id, p.name))
    return m
  }, [products])

  const factoryNames = useMemo(() => {
    const m = new Map<string, string>()
    factories.forEach((f) => m.set(f.id, f.name))
    return m
  }, [factories])

  const visibleShippedUnits = useMemo(
    () => activeUnits
      .filter((u) => u.status === 'shipped' && u.factory_id != null)
      .filter((u) => view === 'all' || u.factory_id === view),
    [activeUnits, view],
  )

  const timelineFrame = useMemo(() => {
    if (visibleShippedUnits.length === 0) {
      return {
        rangeStart: Date.UTC(2026, 0, 1),
        rangeEnd: Date.UTC(2026, 3, 1),
        quarters: [Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1)],
        width: 1800,
      }
    }
    const rangeStart = quarterStartMs(Math.min(...visibleShippedUnits.map((u) => parseMs(u.required_start))))
    const rangeEnd = nextQuarterStartMs(Math.max(...visibleShippedUnits.map((u) => parseMs(u.due_date))))
    const quarters = quarterMarkers(rangeStart, rangeEnd)
    const utidWidth = Math.max(1000, visibleShippedUnits.length * 18, quarters.length * 180)
    return {
      rangeStart,
      rangeEnd,
      quarters,
      width: utidWidth,
    }
  }, [visibleShippedUnits])

  useEffect(() => {
    setRunSelection('current')
    setSelectedRunResult(null)
    setRunHistoryError(null)
    void (async () => {
      try {
        const runs = await api.listScenarioRuns(result.run.scenario_id)
        setSavedRuns(runs.filter((run) => run.id !== result.run.id))
      } catch (e: unknown) {
        setRunHistoryError(((e as { message?: string }).message) ?? 'failed to load saved runs')
      }
    })()
  }, [result.run.id, result.run.scenario_id])

  async function handleRunSelection(value: string) {
    setRunSelection(value)
    setRunHistoryError(null)
    if (value === 'current' || value.startsWith('alt:')) {
      setSelectedRunResult(null)
      return
    }
    if (value.startsWith('run:')) {
      try {
        setSelectedRunResult(await api.getRun(value.slice(4)))
      } catch (e: unknown) {
        setRunHistoryError(((e as { message?: string }).message) ?? 'failed to load saved run')
      }
    }
  }

  const utidChart = useMemo(() => {
    const units = visibleShippedUnits
      .slice()
      .sort((a, b) => {
        const primary = utidSort === 'ship'
          ? a.due_date.localeCompare(b.due_date)
          : a.required_start.localeCompare(b.required_start)
        return primary || a.required_start.localeCompare(b.required_start) || a.due_date.localeCompare(b.due_date) || (a.serial ?? '').localeCompare(b.serial ?? '')
      })
    const labels = units.map((u) => {
      const baseLabel = u.serial || 'Unknown'
      return u.is_anchored ? `⚓ ${baseLabel}` : baseLabel
    })
    const xs: number[] = []
    const ys: string[] = []
    const bases: number[] = []
    const text: string[] = []
    const hover: string[] = []
    const colors: string[] = []
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      const s = parseMs(u.required_start)
      const e = parseMs(u.due_date) + DAY
      const label = labels[i]
      const fn = factoryNames.get(u.factory_id ?? '') ?? u.factory_id ?? ''
      xs.push(e - s)
      ys.push(label)
      bases.push(s)
      text.push(label)
      colors.push(isLateAnchored(u) ? LATE_ANCHOR_COLOR : factoryColor(factories, u.factory_id))
      hover.push(`${label}<br>${fn} · Bay ${(u.bay_index ?? 0) + 1}<br>${u.required_start} → ${u.due_date} (${Math.round((e - s) / DAY)}d)${anchorHoverDetails(u)}`)
    }
    const { rangeStart, rangeEnd, quarters } = timelineFrame
    const quarterShapes = quarters.map((q) => ({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: q,
      x1: q,
      y0: 0,
      y1: 1,
      line: { color: '#94a3b8', width: 1, dash: 'dot' },
      layer: 'above',
    })) as Partial<Plotly.Shape>[]
    return {
      data: [
        {
          type: 'bar',
          orientation: 'h',
          name: 'Plan',
          x: xs,
          y: ys,
          base: bases,
          text,
          textposition: 'inside',
          insidetextanchor: 'start',
          textfont: { color: '#ffffff', size: 10 },
          marker: { color: colors, line: { color: 'rgba(255,255,255,0.6)', width: 1 } },
          hovertext: hover,
          hoverinfo: 'text',
          showlegend: false,
        } as Plotly.Data,
      ],
      layout: {
        autosize: true,
        barmode: 'overlay',
        bargap: 0.25,
        shapes: quarterShapes,
        xaxis: {
          type: 'date',
          title: { text: '' },
          range: [rangeStart, rangeEnd],
          side: 'top',
          dtick: 'M3',
          tickformat: "%b '%y",
          showgrid: true,
          gridcolor: '#e2e8f0',
          griddash: 'dot',
          showticklabels: false,
          ticks: '',
          fixedrange: true,
        },
        yaxis: {
          title: { text: 'UTID' },
          type: 'category',
          categoryorder: 'array',
          categoryarray: labels,
          autorange: 'reversed',
          automargin: false,
          fixedrange: true,
        },
        margin: { l: 140, r: 20, t: 36, b: 20 },
        height: Math.max(260, labels.length * 24 + 95),
      } as Partial<Plotly.Layout>,
      width: Math.max(timelineFrame.width, units.length * 18),
      rangeStart,
      rangeEnd,
      quarters,
    }
  }, [visibleShippedUnits, utidSort, factoryNames, factories, timelineFrame])

  const concurrentCountChart = useMemo(() => {
    const units = visibleShippedUnits
      .slice()
      .sort((a, b) => a.required_start.localeCompare(b.required_start))
    if (units.length === 0) return null

    const factoryIds = [...new Set(units.map((u) => u.factory_id!))].sort()
    if (factoryIds.length === 0) return null

    const allEvents: Array<{ date: string; delta: number }> = []
    for (const u of units) {
      const s = u.required_start
      const e = u.due_date
      allEvents.push({ date: s, delta: 1 })
      const nextDay = new Date(Date.parse(e) + DAY).toISOString().slice(0, 10)
      allEvents.push({ date: nextDay, delta: -1 })
    }
    allEvents.sort((a, b) => a.date.localeCompare(b.date))

    const allDatesSet = new Set<string>()
    for (const ev of allEvents) {
      allDatesSet.add(ev.date)
    }

    if (allDatesSet.size === 0) return null

    const minDate = fmtMs(timelineFrame.rangeStart)
    const rangeMaxDate = fmtMs(timelineFrame.rangeEnd - DAY)

    const dateList: string[] = []
    let currentDate = new Date(minDate)
    const endDate = new Date(rangeMaxDate)

    while (currentDate <= endDate) {
      const iso = currentDate.toISOString().slice(0, 10)
      dateList.push(iso)
      currentDate = new Date(Date.parse(iso) + DAY)
    }

    const factoryEvents = new Map<string, Array<{ date: string; delta: number }>>()
    for (const fid of factoryIds) {
      factoryEvents.set(fid, [])
    }

    for (const u of units) {
      const fid = u.factory_id!
      const s = u.required_start
      const e = u.due_date
      factoryEvents.get(fid)!.push({ date: s, delta: 1 })
      const nextDay = new Date(Date.parse(e) + DAY).toISOString().slice(0, 10)
      factoryEvents.get(fid)!.push({ date: nextDay, delta: -1 })
    }

    for (const events of factoryEvents.values()) {
      events.sort((a, b) => a.date.localeCompare(b.date))
    }

    const countMaps = new Map<string, Map<string, number>>()
    for (const [fid, events] of factoryEvents) {
      const countMap = new Map<string, number>()
      let cur = 0
      for (const ev of events) {
        cur += ev.delta
        countMap.set(ev.date, cur)
      }
      countMaps.set(fid, countMap)
    }

    const traces: Plotly.Data[] = []
    const factoryCounts: number[][] = []
    for (const fid of factoryIds) {
      const countMap = countMaps.get(fid)!
      const counts: number[] = []
      let cur = 0
      for (const d of dateList) {
        cur = countMap.get(d) ?? cur
        counts.push(cur)
      }
      factoryCounts.push(counts)

      traces.push({
        type: 'bar',
        name: factoryNames.get(fid) ?? fid,
        x: dateList,
        y: counts,
        marker: { color: factoryColor(factories, fid), opacity: 0.78, line: { color: 'rgba(255,255,255,0.8)', width: 0.5 } },
        hovertemplate: `${factoryNames.get(fid) ?? fid}<br>%{x}<br>Bays: %{y}<extra></extra>`,
        hoverinfo: 'text',
        showlegend: true,
      } as Plotly.Data)
    }

    const totalCounts = dateList.map((_, i) => factoryCounts.reduce((sum, counts) => sum + counts[i], 0))
    const dailyTotals = dateList.map((date, i) => ({
      date,
      total: totalCounts[i],
      factories: factoryIds.map((factoryId, factoryIndex) => ({
        factoryId,
        factoryName: factoryNames.get(factoryId) ?? factoryId,
        count: factoryCounts[factoryIndex][i],
      })),
    }))
    const maxCount = Math.max(...totalCounts, 0)
    const maxIndex = totalCounts.indexOf(maxCount)
    const maxDate = maxIndex >= 0 ? dateList[maxIndex] : null

    const maxBreakdown: Array<{ factoryId: string; factoryName: string; count: number }> = []
    if (maxDate) {
      for (let i = 0; i < factoryIds.length; i++) {
        const fid = factoryIds[i]
        const count = factoryCounts[i][maxIndex]
        maxBreakdown.push({
          factoryId: fid,
          factoryName: factoryNames.get(fid) ?? fid,
          count,
        })
      }
      maxBreakdown.sort((a, b) => b.count - a.count)
    }

    const minX = timelineFrame.rangeStart
    const maxX = timelineFrame.rangeEnd
    const width = timelineFrame.width
    const quarterShapes = timelineFrame.quarters.map((q) => ({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: q,
      x1: q,
      y0: 0,
      y1: 1,
      line: { color: '#94a3b8', width: 1, dash: 'dot' },
      layer: 'above',
    })) as Partial<Plotly.Shape>[]

    return {
      maxCount,
      maxDate,
      maxBreakdown,
      dailyTotals,
      width,
      data: traces,
      layout: {
        autosize: true,
        barmode: 'stack',
        bargap: 0,
        barnorm: null,
        dragmode: 'pan',
        xaxis: { type: 'date', title: { text: '' }, tickformat: '%b %d', showgrid: true, range: [minX, maxX] },
        yaxis: { title: { text: 'Bays' }, rangemode: 'tozero' },
        margin: { l: 60, r: 20, t: 10, b: 40 },
        height: 120,
        legend: { orientation: 'h', y: -0.2, x: 0.5, xanchor: 'center' },
        shapes: [
          ...quarterShapes,
          ...(maxCount > 0
            ? [
                {
                  type: 'line',
                  x0: minDate,
                  x1: rangeMaxDate,
                  y0: maxCount,
                  y1: maxCount,
                  line: {
                    color: '#ef4444',
                    width: 2,
                    dash: 'dot',
                  },
                } as Plotly.Shape,
              ]
            : []),
        ],
        annotations: maxCount > 0
          ? [
              {
                x: maxDate,
                y: maxCount,
                text: `${maxCount}`,
                xanchor: 'right',
                yanchor: 'bottom',
                showarrow: false,
                font: {
                  color: '#ef4444',
                  size: 12,
                  family: 'Arial',
                },
                bgcolor: 'rgba(255, 255, 255, 0.8)',
                bordercolor: '#ef4444',
                borderwidth: 1,
                borderpad: 2,
              },
            ]
          : [],
      } as Partial<Plotly.Layout>,
    }
  }, [visibleShippedUnits, factories, factoryNames, timelineFrame])

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
          const color = quarterColor(qNum)
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
            const labelText = u.is_anchored ? `⚓ ${utid}` : utid
            xs.push(e - s)
            ys.push(label)
            bases.push(s)
            labels.push(labelText)
            colors.push(isLateAnchored(u) ? LATE_ANCHOR_COLOR : color)
            const serialLine = u.serial ? `UTID ${u.serial}<br>` : ''
            hovers.push(
              `${serialLine}<b>${nm}</b><br>${f.name} · ${shipQuarterLabel(qk)} · Bay ${(u.bay_index ?? 0) + 1}<br>${u.required_start} → ${u.due_date} (${Math.round(
                (e - s) / DAY,
              )}d)${anchorHoverDetails(u)}`,
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
          title: { text: '' },
          side: 'top',
          showgrid: false,
          dtick: 'M3',
          tickformat: "%b '%y",
          range: [timelineFrame.rangeStart, timelineFrame.rangeEnd],
        },
        yaxis: {
          title: { text: merged ? 'Factory · Bay' : 'Bays' },
          type: 'category',
          categoryorder: 'array',
          categoryarray: rowLabels,
          autorange: 'reversed',
          automargin: true,
        },
        margin: { l: 20, r: 20, t: 50, b: 28 },
        legend: { orientation: 'h', y: -0.16 },
        height: Math.max(220, rowLabels.length * 30 + 145),
      }

      return {
        key: shownFactories.map((f) => f.id).join('-') || `chart-${chartIndex}`,
        title: '',
        data: traces,
        layout,
        stats,
        width: Math.max(timelineFrame.width, bucketCount * 180),
      }
    }

    const charts = chartFactoryGroups.map((group, i) => buildChart(group, i))
    return { charts, stats: charts.flatMap((chart) => chart.stats) }
  }, [view, chartMode, showIdle, factories, productNames, activeUnits, timelineFrame])

  const shipmentsByQuarter = useMemo(() => {
    const shipped = activeUnits.filter((u) => u.status === 'shipped' && u.factory_id != null)
    const quarterKeys = Array.from(new Set(shipped.map((u) => shipQuarterKey(u.due_date)))).sort()
    const rows = factories.map((f) => {
      const counts: Record<string, number> = {}
      for (const q of quarterKeys) counts[q] = 0
      for (const u of shipped) {
        if (u.factory_id === f.id) counts[shipQuarterKey(u.due_date)] = (counts[shipQuarterKey(u.due_date)] ?? 0) + 1
      }
      return { factoryId: f.id, factoryName: f.name, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) }
    })
    const totals: Record<string, number> = {}
    for (const q of quarterKeys) totals[q] = rows.reduce((s, r) => s + (r.counts[q] ?? 0), 0)
    return { quarterKeys, rows, totals, grandTotal: Object.values(totals).reduce((s, n) => s + n, 0) }
  }, [factories, activeUnits])

  async function copyShipmentsForExcel() {
    const header = ['Factory', ...shipmentsByQuarter.quarterKeys.map(shipQuarterLabel), 'Total']
    const rows = shipmentsByQuarter.rows.map((r) => [
      r.factoryName,
      ...shipmentsByQuarter.quarterKeys.map((q) => String(r.counts[q] ?? 0)),
      String(r.total),
    ])
    const totalRow = ['Total', ...shipmentsByQuarter.quarterKeys.map((q) => String(shipmentsByQuarter.totals[q] ?? 0)), String(shipmentsByQuarter.grandTotal)]
    const tsv = [header.join('\t'), ...rows.map((r) => r.join('\t')), totalRow.join('\t')].join('\n')
    await navigator.clipboard.writeText(tsv)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function setChartWidthMode(wide: boolean) {
    setWideCharts(wide)
    setChartRevision((v) => v + 1)
  }

  function syncUtidScroll(source: 'top' | 'body') {
    const top = utidTopScrollRef.current
    const body = utidBodyScrollRef.current
    if (!top || !body) return
    if (source === 'top') body.scrollLeft = top.scrollLeft
    else top.scrollLeft = body.scrollLeft
  }

  function captureUtidPlotMargins(_figure: unknown, graphDiv: unknown) {
    const size = (graphDiv as { _fullLayout?: { _size?: { l?: number; r?: number } } })?._fullLayout?._size
    const left = size?.l
    const right = size?.r
    if (typeof left !== 'number' || typeof right !== 'number') return
    setUtidPlotMargins((prev) => (
      Math.abs(prev.left - left) < 1 && Math.abs(prev.right - right) < 1
        ? prev
        : { left, right }
    ))
  }

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
      <div>
        {concurrentCountChart && concurrentCountChart.maxCount > 0 ? (
          <div className="rounded-xl border-2 border-red-200 bg-white p-5 shadow-sm">
            <div className="flex items-baseline gap-3">
              <div className="text-slate-600 text-sm font-medium">Max bays needed</div>
              <div className="text-4xl font-black text-slate-900">{concurrentCountChart.maxCount}</div>
              <div className="text-sm text-slate-500">on {concurrentCountChart.maxDate}</div>
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              {concurrentCountChart.maxBreakdown.map((item) => (
                <div key={item.factoryId} className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-slate-200 shadow-sm">
                  <span
                    className="w-3 h-3 rounded-full shadow-sm"
                    style={{ background: factoryColor(factories, item.factoryId) }}
                  />
                  <span className="text-slate-700 text-sm font-medium">{item.factoryName}</span>
                  <span className="text-slate-900 text-sm font-bold">{item.count}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-600">Run:</span>
          <select
            className="border border-slate-300 rounded px-2 py-1 bg-white max-w-md"
            value={runSelection}
            onChange={(e) => void handleRunSelection(e.target.value)}
          >
            <option value="current">Current run</option>
            {savedRuns.length > 0 && <option disabled>Previous runs</option>}
            {savedRuns.map((run) => (
              <option key={run.id} value={`run:${run.id}`}>
                {runOptionLabel(run)}
              </option>
            ))}
            {alternatives.length > 0 && <option disabled>What-if alternatives</option>}
            {alternatives.map((a) => (
              <option key={a.kind} value={`alt:${a.kind}`}>
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
          {runHistoryError && <span className="text-xs text-rose-600">{runHistoryError}</span>}
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
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
          <button
            type="button"
            className={`px-2.5 py-1 ${wideCharts ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setChartWidthMode(true)}
          >
            Wide
          </button>
          <button
            type="button"
            className={`px-2.5 py-1 border-l border-slate-300 ${!wideCharts ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setChartWidthMode(false)}
          >
            Compact
          </button>
        </div>
        <span className="text-xs text-slate-500">
          UTID timeline colors are by factory; factory/bay Gantt colors are by shipping quarter.
        </span>
      </div>

      {shipmentsByQuarter.quarterKeys.length > 0 && (
        <div className={`${wideCharts ? 'relative left-1/2 -translate-x-1/2 w-[calc(100vw-3rem)]' : 'w-full'} rounded-lg border border-slate-200 bg-white p-4`}>
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-semibold text-slate-700">Shipments per quarter</h4>
            <button
              onClick={copyShipmentsForExcel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy for Excel'}
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Units scheduled to ship in each quarter, separated by assigned factory.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-1 pr-3 font-medium">Factory</th>
                  {shipmentsByQuarter.quarterKeys.map((q) => (
                    <th key={q} className="py-1 px-3 font-medium text-right whitespace-nowrap">
                      {shipQuarterLabel(q)}
                    </th>
                  ))}
                  <th className="py-1 pl-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {shipmentsByQuarter.rows.map((r) => (
                  <tr key={r.factoryId} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                        style={{ background: factoryColor(factories, r.factoryId) }}
                      />
                      {r.factoryName}
                    </td>
                    {shipmentsByQuarter.quarterKeys.map((q) => (
                      <td key={q} className="py-1.5 px-3 text-right">
                        {r.counts[q] || 0}
                      </td>
                    ))}
                    <td className="py-1.5 pl-3 text-right font-medium">{r.total}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1.5 pr-3">Total</td>
                  {shipmentsByQuarter.quarterKeys.map((q) => (
                    <td key={q} className="py-1.5 px-3 text-right">
                      {shipmentsByQuarter.totals[q] || 0}
                    </td>
                  ))}
                  <td className="py-1.5 pl-3 text-right">{shipmentsByQuarter.grandTotal}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className={`${wideCharts ? 'relative left-1/2 -translate-x-1/2 w-[calc(100vw-3rem)]' : 'w-full'} rounded-lg border border-slate-200 bg-white p-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h4 className="text-sm font-semibold text-slate-700">UTID timeline</h4>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
              <button
                type="button"
                className={`px-2.5 py-1 ${utidSort === 'ship' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}
                onClick={() => setUtidSort('ship')}
              >
                Sort by ship
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 border-l border-slate-300 ${utidSort === 'start' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}
                onClick={() => setUtidSort('start')}
              >
                Sort by start
              </button>
            </div>
            <span className="text-xs text-slate-500">Y-axis = UTID, X-axis = date</span>
          </div>
        </div>
        {wideCharts && (
          <div
            ref={utidTopScrollRef}
            className="w-full overflow-x-auto pb-1 mb-2"
            onScroll={() => syncUtidScroll('top')}
          >
            <div style={{ width: `${utidChart.width}px`, height: 1 }} />
          </div>
        )}
        <div
          ref={utidBodyScrollRef}
          className={wideCharts ? 'w-full overflow-x-auto scrollbar-hidden' : 'w-full'}
          onScroll={() => syncUtidScroll('body')}
        >
          <div style={{ width: wideCharts ? `${utidChart.width}px` : '100%' }}>
            <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden rounded border border-slate-100">
              <div className="sticky top-0 z-20 h-40 bg-white/95 backdrop-blur border-b border-slate-200">
                {concurrentCountChart ? (
                  <Plot
                    key={`concurrent-header-${wideCharts ? 'wide' : 'compact'}-${chartRevision}`}
                    data={concurrentCountChart.data}
                    layout={{
                      ...concurrentCountChart.layout,
                      autosize: !wideCharts,
                      width: wideCharts ? utidChart.width : undefined,
                      height: 154,
                      dragmode: false,
                      xaxis: {
                        ...(concurrentCountChart.layout.xaxis as Partial<Plotly.LayoutAxis>),
                        range: [utidChart.rangeStart, utidChart.rangeEnd],
                        side: 'bottom',
                        dtick: 'M3',
                        tickformat: "%b '%y",
                        fixedrange: true,
                      },
                      yaxis: {
                        ...(concurrentCountChart.layout.yaxis as Partial<Plotly.LayoutAxis>),
                        title: { text: 'Bays / day' },
                        fixedrange: true,
                      },
                      margin: { l: utidPlotMargins.left, r: utidPlotMargins.right, t: 8, b: 34 },
                      legend: { orientation: 'h', y: 1.08, x: 1, xanchor: 'right', font: { size: 10 } },
                    }}
                    config={{ displayModeBar: false, displaylogo: false, responsive: !wideCharts }}
                    style={{ width: wideCharts ? `${utidChart.width}px` : '100%', height: 154 }}
                    useResizeHandler={!wideCharts}
                  />
                ) : (
                  <div className="h-full flex items-center px-4 text-xs text-slate-500">No bays per day data</div>
                )}
              </div>
              <Plot
                key={`utid-${wideCharts ? 'wide' : 'compact'}-${utidSort}-${chartRevision}`}
                data={utidChart.data}
                layout={{
                  ...utidChart.layout,
                  autosize: !wideCharts,
                  width: wideCharts ? utidChart.width : undefined,
                }}
                config={{ displayModeBar: false, displaylogo: false, responsive: !wideCharts }}
                style={{ width: wideCharts ? `${utidChart.width}px` : '100%' }}
                useResizeHandler={!wideCharts}
                onInitialized={captureUtidPlotMargins}
                onUpdate={captureUtidPlotMargins}
              />
            </div>
          </div>
        </div>
      </div>

      <div className={`${wideCharts ? 'relative left-1/2 -translate-x-1/2 w-[calc(100vw-3rem)]' : 'w-full'} rounded-lg border border-slate-200 bg-white`}>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
          onClick={() => setFactoryGanttOpen((v) => !v)}
        >
          <div>
            <h4 className="text-sm font-semibold text-slate-700">Factory / bay Gantt</h4>
            <div className="text-xs text-slate-500">
              Detailed bay-level schedule is collapsed by default.
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform duration-300 ${factoryGanttOpen ? 'rotate-180' : ''}`} />
        </button>
        <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${factoryGanttOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden">
            <div className="space-y-3 border-t border-slate-100 p-3">
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
                      key={`${chart.key}-${wideCharts ? 'wide' : 'compact'}-${factoryGanttOpen ? 'open' : 'closed'}-${chartRevision}`}
                      data={chart.data}
                      layout={{
                        ...chart.layout,
                        autosize: !wideCharts,
                        width: wideCharts ? chart.width : undefined,
                      }}
                      config={{ displayModeBar: false, displaylogo: false, responsive: !wideCharts }}
                      style={{ width: wideCharts ? `${chart.width}px` : '100%' }}
                      useResizeHandler={!wideCharts}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

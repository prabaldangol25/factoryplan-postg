import { useEffect, useMemo, useState } from 'react'
import PlotComponent from 'react-plotly.js'
import type { Factory, Product, RunResult, ScheduledUnit } from '../types'

const Plot = ((PlotComponent as unknown as { default?: typeof PlotComponent }).default ?? PlotComponent) as typeof PlotComponent

interface Props {
  scenarioId: string
  result: RunResult | null
  context: { factories: Factory[]; products: Product[] } | null
  onGoToRun: () => void
}

interface SubprocessConfig {
  name: string
  pct: number
  heads: number
}

type Period = 'day' | 'week' | 'month' | 'quarter'
type Method = 'average' | 'top3' | 'peak'
type ChartType = 'area' | 'line' | 'bar'

const DAY = 86400000
const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706']
const DEFAULT_KEY = '__default__'

function defaultConfigs(): SubprocessConfig[] {
  return [
    { name: 'Subprocess 1', pct: 25, heads: 1 },
    { name: 'Subprocess 2', pct: 25, heads: 1 },
    { name: 'Subprocess 3', pct: 25, heads: 1 },
    { name: 'Subprocess 4', pct: 25, heads: 1 },
  ]
}

function cloneConfigs(configs: SubprocessConfig[]): SubprocessConfig[] {
  return configs.map((c) => ({ ...c }))
}

function storageKey(scenarioId: string): string {
  return `factoryplan:headcount:${scenarioId}`
}

function parseMs(d: string): number {
  return Date.parse(d)
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function quarterKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`
}

function isoWeekKey(ms: number): string {
  const d = new Date(ms)
  const day = (d.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3))
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function aggregate(values: number[], method: Method): number {
  if (values.length === 0) return 0
  if (method === 'peak') return Math.max(...values)
  if (method === 'top3') {
    const sorted = [...values].sort((a, b) => b - a)
    const n = Math.min(3, sorted.length)
    return sorted.slice(0, n).reduce((a, b) => a + b, 0) / n
  }
  return values.reduce((a, b) => a + b, 0) / values.length
}

function splitUnit(
  u: ScheduledUnit,
  configs: SubprocessConfig[],
): Array<{ name: string; start: number; end: number; heads: number }> {
  const start = parseMs(u.required_start)
  const end = parseMs(u.due_date)
  const duration = Math.max(1, Math.round((end - start) / DAY) + 1)
  const pctTotal = configs.reduce((s, c) => s + Math.max(0, c.pct), 0)
  if (pctTotal <= 0) return []
  let cum = 0
  return configs.flatMap((c, i) => {
    const pct = Math.max(0, c.pct)
    const sOff = Math.floor((cum / pctTotal) * duration)
    cum += pct
    const eOff = i === configs.length - 1 ? duration - 1 : Math.floor((cum / pctTotal) * duration) - 1
    if (pct <= 0 || eOff < sOff) return []
    return [{ name: c.name || `Subprocess ${i + 1}`, start: start + sOff * DAY, end: start + eOff * DAY, heads: c.heads }]
  })
}

export function HeadcountView({ scenarioId, result, context, onGoToRun }: Props) {
  const [configsByKey, setConfigsByKey] = useState<Record<string, SubprocessConfig[]>>({
    [DEFAULT_KEY]: defaultConfigs(),
  })
  const [selectedConfigKey, setSelectedConfigKey] = useState(DEFAULT_KEY)
  const [period, setPeriod] = useState<Period>('week')
  const [method, setMethod] = useState<Method>('peak')
  const [chartType, setChartType] = useState<ChartType>('area')
  const [shiftHours, setShiftHours] = useState(8)
  const [factoryFilter, setFactoryFilter] = useState('all')
  const [productFilter, setProductFilter] = useState('all')
  const [dirty, setDirty] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  useEffect(() => {
    setSelectedConfigKey(DEFAULT_KEY)
    setDirty(false)
    setSavedMsg(null)
    try {
      const raw = localStorage.getItem(storageKey(scenarioId))
      if (!raw) {
        setConfigsByKey({ [DEFAULT_KEY]: defaultConfigs() })
        setShiftHours(8)
        return
      }
      const parsed = JSON.parse(raw) as {
        configsByKey?: Record<string, SubprocessConfig[]>
        shiftHours?: number
      }
      setConfigsByKey(parsed.configsByKey && parsed.configsByKey[DEFAULT_KEY] ? parsed.configsByKey : { [DEFAULT_KEY]: defaultConfigs() })
      setShiftHours(typeof parsed.shiftHours === 'number' ? parsed.shiftHours : 8)
    } catch {
      setConfigsByKey({ [DEFAULT_KEY]: defaultConfigs() })
      setShiftHours(8)
    }
  }, [scenarioId])

  const selectedConfigs =
    configsByKey[selectedConfigKey] ?? configsByKey[DEFAULT_KEY] ?? defaultConfigs()
  const selectedProduct = context?.products.find((p) => p.id === selectedConfigKey) ?? null
  const hasProductOverride = selectedConfigKey !== DEFAULT_KEY && configsByKey[selectedConfigKey] != null

  function updateSelectedConfig(index: number, patch: Partial<SubprocessConfig>) {
    setConfigsByKey((prev) => {
      const base = cloneConfigs(prev[selectedConfigKey] ?? prev[DEFAULT_KEY] ?? defaultConfigs())
      base[index] = { ...base[index], ...patch }
      return { ...prev, [selectedConfigKey]: base }
    })
    setDirty(true)
    setSavedMsg(null)
  }

  function useDefaultForSelectedProduct() {
    if (selectedConfigKey === DEFAULT_KEY) return
    setConfigsByKey((prev) => {
      const next = { ...prev }
      delete next[selectedConfigKey]
      return next
    })
    setDirty(true)
    setSavedMsg(null)
  }

  function saveSettings() {
    localStorage.setItem(storageKey(scenarioId), JSON.stringify({ configsByKey, shiftHours }))
    setDirty(false)
    setSavedMsg('Saved')
    window.setTimeout(() => setSavedMsg(null), 1500)
  }

  const productName = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of context?.products ?? []) m.set(p.id, p.name)
    return m
  }, [context])

  const filteredScheduledUnits = useMemo(() => {
    if (!result) return []
    return result.units.filter(
      (u) =>
        u.status === 'shipped' &&
        u.factory_id &&
        (factoryFilter === 'all' || u.factory_id === factoryFilter) &&
        (productFilter === 'all' || u.product_id === productFilter),
    )
  }, [factoryFilter, productFilter, result])

  const prep = useMemo(() => {
    if (!result || !context) return null
    const tasks = filteredScheduledUnits.flatMap((u) => {
      const configs = configsByKey[u.product_id] ?? configsByKey[DEFAULT_KEY] ?? defaultConfigs()
      return splitUnit(u, configs).map((t) => ({
        ...t,
        product: productName.get(u.product_id) ?? u.product_id,
      }))
    })
    if (tasks.length === 0) return null

    const minStart = Math.min(...tasks.map((t) => t.start))
    const maxEnd = Math.max(...tasks.map((t) => t.end))
    const numDays = Math.round((maxEnd - minStart) / DAY) + 1
    const names = [...new Set(tasks.map((t) => t.name))].sort()
    const diffs = new Map<string, number[]>()
    for (const n of names) diffs.set(n, new Array(numDays + 1).fill(0))

    for (const t of tasks) {
      const diff = diffs.get(t.name)
      if (!diff) continue
      const si = Math.max(0, Math.round((t.start - minStart) / DAY))
      const ei = Math.min(numDays - 1, Math.round((t.end - minStart) / DAY))
      diff[si] += t.heads
      diff[ei + 1] -= t.heads
    }

    const dates: string[] = []
    const dailyByName = new Map<string, number[]>()
    for (const n of names) dailyByName.set(n, [])
    const totalDaily: number[] = []
    const running = new Map<string, number>()
    for (const n of names) running.set(n, 0)

    for (let i = 0; i < numDays; i++) {
      dates.push(fmtDate(minStart + i * DAY))
      let total = 0
      for (const n of names) {
        const v = (running.get(n) ?? 0) + diffs.get(n)![i]
        running.set(n, v)
        dailyByName.get(n)!.push(v)
        total += v
      }
      totalDaily.push(total)
    }

    return { minStart, numDays, dates, names, dailyByName, totalDaily }
  }, [configsByKey, context, filteredScheduledUnits, productName, result])

  const agg = useMemo(() => {
    if (!prep) return null
    if (period === 'day') return { x: prep.dates, byName: prep.dailyByName, total: prep.totalDaily }
    const keyOf = period === 'week' ? isoWeekKey : period === 'month' ? monthKey : quarterKey
    const groups = new Map<string, number[]>()
    for (let i = 0; i < prep.numDays; i++) {
      const key = keyOf(prep.minStart + i * DAY)
      const arr = groups.get(key) ?? []
      arr.push(i)
      groups.set(key, arr)
    }
    const keys = [...groups.keys()].sort()
    const byName = new Map<string, number[]>()
    for (const n of prep.names) {
      const vals = prep.dailyByName.get(n) ?? []
      byName.set(n, keys.map((k) => aggregate(groups.get(k)!.map((i) => vals[i]), method)))
    }
    const total = keys.map((k) => aggregate(groups.get(k)!.map((i) => prep.totalDaily[i]), method))
    return { x: keys, byName, total }
  }, [method, period, prep])

  const traces = useMemo(() => {
    if (!agg || !prep) return []
    return prep.names.map((name, i) => {
      const base = { name, x: agg.x, y: agg.byName.get(name) ?? [] }
      if (chartType === 'bar') return { ...base, type: 'bar', marker: { color: COLORS[i % COLORS.length] } } as Plotly.Data
      if (chartType === 'line') return { ...base, type: 'scatter', mode: 'lines', line: { color: COLORS[i % COLORS.length], width: 2 } } as Plotly.Data
      return { ...base, type: 'scatter', mode: 'lines', stackgroup: 'one', line: { color: COLORS[i % COLORS.length], width: 2 }, fill: 'tonexty' } as Plotly.Data
    })
  }, [agg, chartType, prep])

  if (!result || !context) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500 text-sm">
        No schedule yet.{' '}
        <button className="text-indigo-600 hover:underline" onClick={onGoToRun}>
          Go to the Run tab
        </button>{' '}
        to compute a schedule, then come back here for headcount planning.
      </div>
    )
  }

  const peakHeads = agg?.total.length ? Math.max(...agg.total) : 0
  const peakHours = peakHeads * shiftHours
  const scheduledUnitCount = filteredScheduledUnits.length
  const pctTotal = selectedConfigs.reduce((s, c) => s + c.pct, 0)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold mb-1">Headcount planning</h3>
        <p className="text-sm text-slate-500 mb-4">
          Splits each scheduled unit into four sequential subprocesses, then counts active heads over time.
          Product-specific rows override the default setup.
        </p>

        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Edit subprocess rules for</label>
              <select
                className="border border-slate-300 rounded px-2 py-1 bg-white"
                value={selectedConfigKey}
                onChange={(e) => {
                  const next = e.target.value
                  setSelectedConfigKey(next)
                  setProductFilter(next === DEFAULT_KEY ? 'all' : next)
                }}
              >
                <option value={DEFAULT_KEY}>Default for all products</option>
                {context.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {configsByKey[p.id] ? ' (custom)' : ' (uses default)'}
                  </option>
                ))}
              </select>
            </div>
            {selectedProduct && (
              <button
                type="button"
                className="px-3 py-1.5 border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={!hasProductOverride}
                onClick={useDefaultForSelectedProduct}
              >
                Use default for {selectedProduct.name}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {savedMsg && <span className="text-xs text-emerald-700">{savedMsg}</span>}
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
            <button
              type="button"
              className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
              onClick={saveSettings}
            >
              Save headcount setup
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div>
            <div className="text-slate-500 text-sm">Peak heads</div>
            <div className="text-2xl font-semibold">{peakHeads.toFixed(1)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-sm">Peak daily hours</div>
            <div className="text-2xl font-semibold">{peakHours.toFixed(1)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-sm">Scheduled units</div>
            <div className="text-2xl font-semibold">{scheduledUnitCount}</div>
          </div>
          <div>
            <div className="text-slate-500 text-sm">Subprocess cycle %</div>
            <div className={`text-2xl font-semibold ${Math.round(pctTotal) === 100 ? '' : 'text-amber-700'}`}>
              {pctTotal.toFixed(0)}%
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 text-sm mb-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Factory</label>
            <select className="border border-slate-300 rounded px-2 py-1 bg-white" value={factoryFilter} onChange={(e) => setFactoryFilter(e.target.value)}>
              <option value="all">All factories</option>
              {context.factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Product filter (chart & metrics)</label>
            <select
              className="border border-slate-300 rounded px-2 py-1 bg-white"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
            >
              <option value="all">All products</option>
              {context.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Period</label>
            <select className="border border-slate-300 rounded px-2 py-1 bg-white" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Aggregation</label>
            <select className="border border-slate-300 rounded px-2 py-1 bg-white" value={method} onChange={(e) => setMethod(e.target.value as Method)} disabled={period === 'day'}>
              <option value="peak">Peak</option>
              <option value="top3">Top 3 avg</option>
              <option value="average">Average</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Chart</label>
            <select className="border border-slate-300 rounded px-2 py-1 bg-white" value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
              <option value="area">Stacked area</option>
              <option value="line">Line</option>
              <option value="bar">Bar</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Shift hours</label>
            <input
              type="number"
              min={0}
              step={0.5}
              className="w-24 border border-slate-300 rounded px-2 py-1 text-sm"
              value={shiftHours}
              onChange={(e) => {
                setShiftHours(parseFloat(e.target.value) || 0)
                setDirty(true)
                setSavedMsg(null)
              }}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="text-xs text-slate-500 mb-2">
            Editing:{' '}
            <span className="font-medium text-slate-700">
              {selectedProduct ? selectedProduct.name : 'Default for all products'}
            </span>
            {selectedProduct && !hasProductOverride && ' — currently inherited from default; editing will create an override.'}
          </div>
          <table className="text-sm border border-slate-200 bg-white">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-2 py-1 font-medium">Subprocess</th>
                <th className="text-right px-2 py-1 font-medium">Cycle %</th>
                <th className="text-right px-2 py-1 font-medium">Heads / active unit</th>
              </tr>
            </thead>
            <tbody>
              {selectedConfigs.map((c, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1">
                    <input
                      className="border border-slate-300 rounded px-2 py-1 text-sm"
                      value={c.name}
                      onChange={(e) => updateSelectedConfig(i, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="w-24 border border-slate-300 rounded px-2 py-1 text-sm text-right"
                      value={c.pct}
                      onChange={(e) => updateSelectedConfig(i, { pct: parseFloat(e.target.value) || 0 })}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="w-28 border border-slate-300 rounded px-2 py-1 text-sm text-right"
                      value={c.heads}
                      onChange={(e) => updateSelectedConfig(i, { heads: parseFloat(e.target.value) || 0 })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3">
        {agg ? (
          <Plot
            data={traces}
            layout={{
              height: 520,
              barmode: chartType === 'bar' ? 'stack' : undefined,
              margin: { l: 60, r: 20, t: 20, b: 80 },
              xaxis: { title: { text: period === 'day' ? 'Date' : 'Period' } },
              yaxis: { title: { text: 'Heads' } },
              legend: { orientation: 'h', y: -0.2 },
            }}
            config={{ displayModeBar: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        ) : (
          <div className="p-8 text-center text-sm text-slate-500">No shipped units to analyze.</div>
        )}
      </div>
    </div>
  )
}

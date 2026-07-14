import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type PlotComponent from 'react-plotly.js'
import { Plus, Trash2, Pencil, Check, X, Play, Loader2, Anchor, BarChart3 } from 'lucide-react'
import type { Factory, Product, RunResult, ScenarioOrder } from '../types'
import * as api from '../api'

const Plot = lazy(() => import('react-plotly.js'))
type PlotProps = ComponentProps<typeof PlotComponent>

interface DialProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}

function Dial({ value, onChange, min = 1, max = 20 }: DialProps) {
  const [isDragging, setIsDragging] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const range = max - min
  const spreadPosition = range === 0 ? 0 : ((max - value) / range) * 100
  const arcAngle = 155 - (spreadPosition / 100) * 130
  const leverAngle = 90 - arcAngle
  const mode = spreadPosition < 35 ? 'tight' : spreadPosition > 70 ? 'spread' : 'balanced'
  const previewBars = Array.from({ length: 10 }, (_, i) => {
    const spreadFactor = spreadPosition / 100
    const stackedLeft = 6
    const linearLeft = 6 + (i / 9) * 78
    return {
      label: `U${i + 1}`,
      left: stackedLeft + (linearLeft - stackedLeft) * spreadFactor,
      width: 10,
    }
  })

  const updateFromPoint = useCallback((clientX: number, clientY: number) => {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const hingeX = rect.left + rect.width / 2
    const hingeY = rect.top + 126
    const rawAngle = Math.atan2(hingeY - clientY, clientX - hingeX) * 180 / Math.PI
    const clampedAngle = Math.max(25, Math.min(155, rawAngle))
    const pct = (155 - clampedAngle) / 130
    const nextValue = Math.round(max - pct * range)
    onChange(Math.max(min, Math.min(max, nextValue)))
  }, [max, min, onChange, range])

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true)
    updateFromPoint(e.clientX, e.clientY)
  }

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => updateFromPoint(e.clientX, e.clientY)
    const handleMouseUp = () => setIsDragging(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, updateFromPoint])

  return (
    <div className="w-full rounded-xl border border-stone-500 bg-gradient-to-b from-stone-700 via-stone-600 to-stone-800 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_12px_26px_rgba(15,23,42,0.24)]">
      <div className="grid grid-cols-[20rem_1fr] gap-5">
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] font-black uppercase tracking-[0.18em] text-stone-200">
            <span className={mode === 'tight' ? 'text-amber-200' : undefined}>Tight</span>
            <span className={mode === 'spread' ? 'text-amber-200' : undefined}>Spread</span>
          </div>
          <div
            ref={trackRef}
            onMouseDown={handleMouseDown}
            className="relative h-40 cursor-grab select-none active:cursor-grabbing"
            style={{ userSelect: 'none' }}
          >
            <div className="absolute left-1/2 top-3 h-32 w-64 -translate-x-1/2 overflow-hidden rounded-t-full border-x-4 border-t-4 border-stone-950 bg-gradient-to-b from-zinc-300 via-stone-400 to-stone-600 shadow-[inset_0_8px_18px_rgba(0,0,0,0.25)]">
              <div className="absolute inset-2 rounded-t-full border-x-2 border-t-2 border-amber-950/70" />
              <div className="absolute bottom-0 left-1/2 h-32 w-px -translate-x-1/2 bg-stone-700/60" />
              <div className="absolute bottom-0 left-1/2 h-28 w-56 -translate-x-1/2 rounded-t-full border-t-8 border-dashed border-stone-800/45" />
              {Array.from({ length: 11 }).map((_, i) => {
                const angle = -65 + i * 13
                const active = Math.abs(angle - leverAngle) < 7
                return (
                  <div
                    key={i}
                    className={`absolute bottom-0 left-1/2 origin-bottom rounded ${active ? 'h-7 w-1.5 bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.9)]' : 'h-5 w-1 bg-stone-800'}`}
                    style={{ transform: `translateX(-50%) rotate(${angle}deg) translateY(-106px)` }}
                  />
                )
              })}
              <div className="absolute bottom-4 left-5 rounded bg-stone-900/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-100">Pack</div>
              <div className="absolute bottom-4 right-5 rounded bg-stone-900/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-100">Space</div>
            </div>
            <div className="absolute bottom-2 left-1/2 h-11 w-11 -translate-x-1/2 rounded-full border-4 border-stone-950 bg-gradient-to-br from-zinc-100 via-zinc-500 to-zinc-900 shadow-[0_8px_18px_rgba(0,0,0,0.52)]" />
            <div className="absolute bottom-[24px] left-1/2 h-5 w-5 -translate-x-1/2 rounded-full border border-amber-800 bg-amber-950 shadow-inner" />
            <div
              className="absolute bottom-[30px] left-1/2 h-28 w-8 -translate-x-1/2 transition-transform duration-75"
              style={{ transform: `translateX(-50%) rotate(${leverAngle}deg)`, transformOrigin: '50% 100%' }}
            >
              <div className={`absolute bottom-0 left-1/2 h-28 w-3.5 -translate-x-1/2 rounded-full border border-amber-950 bg-gradient-to-r from-amber-950 via-orange-700 to-amber-900 shadow-[0_10px_18px_rgba(0,0,0,0.45)] ${isDragging ? 'brightness-125' : ''}`} />
              <div className={`absolute -top-3 left-1/2 h-9 w-12 -translate-x-1/2 rounded-md border-2 border-stone-950 bg-gradient-to-b from-red-700 via-red-900 to-red-950 shadow-[0_8px_14px_rgba(0,0,0,0.5)] ${isDragging ? 'translate-y-0.5' : ''}`} />
              <div className="absolute -top-1 left-1/2 h-1.5 w-8 -translate-x-1/2 rounded bg-red-300/40" />
            </div>
            <div className="absolute bottom-0 left-3 h-2 w-2 rounded-full bg-stone-300 shadow-inner" />
            <div className="absolute bottom-0 right-3 h-2 w-2 rounded-full bg-stone-300 shadow-inner" />
            <div className={`absolute left-1/2 top-1 h-2 w-2 -translate-x-1/2 rounded-full ${isDragging ? 'bg-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.95)]' : 'bg-stone-900'}`} />
          </div>
        </div>
        <div className="rounded-lg border border-stone-900 bg-stone-950/75 p-2 text-stone-100">
          <div className="mb-2 flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-stone-400">
            <span>Sample Gantt</span>
            <span>{value}/week</span>
          </div>
          <div className="relative h-48 rounded border border-stone-700 bg-gradient-to-r from-stone-900 via-stone-800 to-stone-900 px-2 py-2">
            <div className="absolute left-[28%] top-0 bottom-0 w-px bg-stone-700/70" />
            <div className="absolute left-[52%] top-0 bottom-0 w-px bg-stone-700/70" />
            <div className="absolute left-[76%] top-0 bottom-0 w-px bg-stone-700/70" />
            {previewBars.map((bar, i) => (
              <div key={bar.label} className="relative flex h-4 items-center gap-2 text-[9px] text-stone-400">
                <span className="w-6 font-mono">{bar.label}</span>
                <div className="relative h-2.5 flex-1 rounded bg-stone-800 shadow-inner">
                  <div
                    className="absolute top-0 h-2.5 rounded-sm border border-amber-900 bg-gradient-to-r from-amber-400 to-orange-500 shadow-[0_0_8px_rgba(251,191,36,0.35)]"
                    style={{ left: `${Math.max(0, Math.min(88, bar.left))}%`, width: `${bar.width}%` }}
                    title={`Sample unit ${i + 1}`}
                  />
                </div>
              </div>
            ))}
            <div className="mt-1 flex justify-between pl-8 text-[9px] font-black uppercase tracking-widest text-stone-500">
              <span>Week 1</span>
              <span>Week 8</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface Props {
  scenarioId: string
  onResult?: (
    result: RunResult,
    context: { factories: Factory[]; products: Product[]; orders: ScenarioOrder[] },
  ) => void
}

interface WeekCell {
  week_start: string
  bays: number
}

interface FactoryForm {
  name: string
  changeoverDays: number
  weekMatrix: Record<string, WeekCell>
}

interface OrderGridRow {
  utid: string
  build_type: string
  customer: string
  cycle_time_days: string
  due_date?: string
  anchor_factory_id?: string
}

function parseWeekStart(raw: string): string | null {
  const v = raw.trim()
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const [, y, m, d] = iso
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const slash = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (slash) {
    const [, m, d, yRaw] = slash
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

function addDaysIso(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

function parseNumberCell(raw: string): number | null {
  const v = raw.trim().replace(/,/g, '')
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

function parsePastedNumbers(text: string): number[] {
  return text
    .replace(/\r/g, '\n')
    .split(/\s+/u)
    .map(parseNumberCell)
    .filter((n): n is number => n != null)
}

function blankOrderRow(): OrderGridRow {
  return { utid: '', build_type: '', customer: '', cycle_time_days: '', due_date: undefined, anchor_factory_id: undefined }
}

function orderRowsFromSaved(rows: ScenarioOrder[]): OrderGridRow[] {
  return ensureBlankOrderRows(
    rows.map((r) => ({
      utid: r.utid,
      build_type: r.build_type,
      customer: r.customer,
      cycle_time_days: String(r.cycle_time_days),
      due_date: r.due_date,
      anchor_factory_id: r.anchor_factory_id,
    })),
  )
}

function ensureBlankOrderRows(rows: OrderGridRow[], minBlank = 10): OrderGridRow[] {
  const out = rows.slice()
  let blank = 0
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]
    if (r.utid || r.build_type || r.customer || r.cycle_time_days) break
    blank++
  }
  while (blank < minBlank) {
    out.push(blankOrderRow())
    blank++
  }
  return out
}

function parseOrderGridRows(rows: OrderGridRow[]): api.OrderInput[] {
  return rows
    .map((r) => ({
      utid: r.utid.trim(),
      build_type: r.build_type.trim(),
      customer: r.customer.trim(),
      cycle_time_days: parseInt(r.cycle_time_days.trim(), 10),
      due_date: r.due_date,
      anchor_factory_id: r.anchor_factory_id,
    }))
    .filter((r) => r.utid && r.customer && Number.isFinite(r.cycle_time_days) && r.cycle_time_days > 0)
}

function splitOrderClipboard(text: string): string[][] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((r) => r.split('\t').map((c) => c.trim()))
    .filter((r) => r.some(Boolean))
}

function emptyForm(): FactoryForm {
  return { name: '', changeoverDays: 0, weekMatrix: {} }
}

function formFromFactory(f: Factory): FactoryForm {
  const weekMatrix: Record<string, WeekCell> = {}
  for (const bw of f.bay_weeks ?? []) {
    weekMatrix[bw.week_start] = { week_start: bw.week_start, bays: bw.bays }
  }
  return { name: f.name, changeoverDays: f.changeover_days ?? 0, weekMatrix }
}

function weekSummary(f: Factory): string {
  const weeks = f.bay_weeks ?? []
  if (weeks.length === 0) return 'No weekly values saved'
  const sorted = weeks.slice().sort((a, b) => a.week_start.localeCompare(b.week_start))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return `${weeks.length} weeks (${first.week_start}: ${first.bays} → ${last.week_start}: ${last.bays})`
}

export function FactoryEditor({ scenarioId, onResult }: Props) {
  const [factories, setFactories] = useState<Factory[]>([])
  const [orders, setOrders] = useState<ScenarioOrder[]>([])
  const [orderRows, setOrderRows] = useState<OrderGridRow[]>(() => ensureBlankOrderRows([]))
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [maxStartsPerWeek, setMaxStartsPerWeek] = useState(2)
  const [leadTimePct, setLeadTimePct] = useState('0')
  const [leadTimeDays, setLeadTimeDays] = useState('0')
  const [factorySpacingOverrides, setFactorySpacingOverrides] = useState<Record<string, string>>({})
  const [factoryLeadTimeOverrides, setFactoryLeadTimeOverrides] = useState<Record<string, string>>({})
  const [factoryLeadTimeDayOverrides, setFactoryLeadTimeDayOverrides] = useState<Record<string, string>>({})
  const [form, setForm] = useState<FactoryForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const formRef = useRef<HTMLDivElement>(null)
  const orderSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const orderSaveRequestRef = useRef(0)
  const [weekRange, setWeekRange] = useState<{ start: string; count: number }>(() => ({
    start: '2026-08-02',
    count: 129,
  }))
  const [showWeeklyGraph, setShowWeeklyGraph] = useState(false)
  const [anchorStatuses, setAnchorStatuses] = useState<Record<string, api.AnchorStatus>>({})
  const [anchorDialogOpen, setAnchorDialogOpen] = useState(false)
  const [anchorDate, setAnchorDate] = useState('')
  const [anchorFactoryId, setAnchorFactoryId] = useState('')

  function scheduleOrderSave(rows: OrderGridRow[]) {
    if (orderSaveTimerRef.current) clearTimeout(orderSaveTimerRef.current)
    const requestId = ++orderSaveRequestRef.current
    const ordersToSave = parseOrderGridRows(rows)
    orderSaveTimerRef.current = setTimeout(() => {
      void api
        .replaceOrders(scenarioId, ordersToSave)
        .then((saved) => {
          if (requestId === orderSaveRequestRef.current) setOrders(saved)
        })
        .catch((e: unknown) => {
          if (requestId === orderSaveRequestRef.current) {
            setError(((e as { message?: string }).message) ?? 'auto-save failed')
          }
        })
    }, 1000)
  }

  useEffect(() => () => {
    if (orderSaveTimerRef.current) clearTimeout(orderSaveTimerRef.current)
  }, [scenarioId])

  const reload = useCallback(async () => {
    try {
      setError(null)
      const [factoryList, orderList, statusList] = await Promise.all([
        api.listFactories(scenarioId),
        api.listOrders(scenarioId),
        api.listAnchorStatuses(scenarioId),
      ])
      setFactories(factoryList)
      setOrders(orderList)
      setOrderRows(orderRowsFromSaved(orderList))
      setAnchorStatuses(Object.fromEntries(statusList.map((s) => [s.utid, s])))
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'load failed')
    }
  }, [scenarioId])

  useEffect(() => {
    if (!scenarioId) return
    const timer = window.setTimeout(() => void reload(), 0)
    return () => window.clearTimeout(timer)
  }, [scenarioId, reload])

  const weekStartIso = useMemo(() => parseWeekStart(weekRange.start), [weekRange.start])
  const weeks = useMemo(
    () =>
      weekStartIso
        ? Array.from({ length: Math.max(1, weekRange.count) }, (_, i) => addDaysIso(weekStartIso, i * 7))
        : [],
    [weekStartIso, weekRange.count],
  )

  const factorySpacingLimits = useMemo(() => {
    return Object.fromEntries(
      Object.entries(factorySpacingOverrides)
        .map(([factoryId, raw]) => [factoryId, parseInt(raw, 10)] as const)
        .filter(([, n]) => Number.isFinite(n) && n > 0),
    )
  }, [factorySpacingOverrides])

  const globalLeadTimePct = useMemo(() => {
    const n = parseFloat(leadTimePct)
    return Number.isFinite(n) ? n : 0
  }, [leadTimePct])

  const factoryLeadTimeLimits = useMemo(() => {
    return Object.fromEntries(
      Object.entries(factoryLeadTimeOverrides)
        .map(([factoryId, raw]) => [factoryId, parseFloat(raw)] as const)
        .filter(([, n]) => Number.isFinite(n) && n !== 0),
    )
  }, [factoryLeadTimeOverrides])

  const globalLeadTimeDays = useMemo(() => {
    const n = parseInt(leadTimeDays, 10)
    return Number.isFinite(n) ? n : 0
  }, [leadTimeDays])

  const factoryLeadTimeDayLimits = useMemo(() => {
    return Object.fromEntries(
      Object.entries(factoryLeadTimeDayOverrides)
        .map(([factoryId, raw]) => [factoryId, parseInt(raw, 10)] as const)
        .filter(([, n]) => Number.isFinite(n) && n !== 0),
    )
  }, [factoryLeadTimeDayOverrides])

  const capacitySummary = useMemo(() => {
    const starts = factories.flatMap((f) => f.bay_weeks.map((w) => w.week_start)).sort()
    if (starts.length === 0) return null
    const first = starts[0]
    const last = starts[starts.length - 1]
    const weekCount = Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / (7 * 86400000)) + 1)
    const plannedRows = parseOrderGridRows(orderRows).length || orders.length
    const autoStarts = Math.max(1, Math.ceil(plannedRows / weekCount))
    return { first, last, weekCount, plannedRows, autoStarts }
  }, [factories, orderRows, orders.length])

  const weeklyGraphData: PlotProps['data'] = [{
    x: Object.keys(form.weekMatrix).sort(),
    y: Object.keys(form.weekMatrix).sort().map((week) => form.weekMatrix[week].bays),
    type: 'bar',
    marker: { color: '#4f46e5' },
    name: 'Bays',
  }]
  const weeklyGraphLayout: PlotProps['layout'] = {
    xaxis: { title: { text: 'Week' } },
    yaxis: { title: { text: 'Bays Available' } },
    margin: { l: 50, r: 20, t: 20, b: 50 },
    height: 300,
    plot_bgcolor: '#ffffff',
    paper_bgcolor: '#ffffff',
  }

  function startEdit(f: Factory) {
    setEditingId(f.id)
    setError(null)
    setMessage(null)
    setForm(formFromFactory(f))
    const sorted = (f.bay_weeks ?? []).slice().sort((a, b) => a.week_start.localeCompare(b.week_start))
    if (sorted.length > 0) setWeekRange({ start: sorted[0].week_start, count: Math.max(129, sorted.length) })
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  function cancelEdit() {
    setEditingId(null)
    setError(null)
    setMessage(null)
    setForm(emptyForm())
  }

  function normalizeStartWeek() {
    const parsed = parseWeekStart(weekRange.start)
    if (parsed) setWeekRange((r) => ({ ...r, start: parsed }))
  }

  function handleWeekPaste(e: React.ClipboardEvent<HTMLInputElement>, startIndex: number) {
    const nums = parsePastedNumbers(e.clipboardData.getData('text'))
    if (nums.length === 0 || !weekStartIso) return
    e.preventDefault()
    setWeekRange((r) => ({ ...r, count: Math.max(r.count, startIndex + nums.length) }))
    setForm((f) => {
      const next = { ...f, weekMatrix: { ...f.weekMatrix } }
      for (let i = 0; i < nums.length; i++) {
        const week_start = addDaysIso(weekStartIso, (startIndex + i) * 7)
        next.weekMatrix[week_start] = { week_start, bays: nums[i] }
      }
      return next
    })
    setMessage(`Pasted ${nums.length} weekly bay value${nums.length === 1 ? '' : 's'}. Click ${editingId ? 'Save changes' : 'Add factory'} to save them.`)
  }

  async function handleSubmit() {
    const name = form.name.trim()
    if (!name) {
      setError('enter a factory name first')
      return
    }
    if (!weekStartIso) {
      setError('enter a valid start week like 8/2/26 or 2026-08-02')
      return
    }
    const bay_weeks = Object.values(form.weekMatrix)
      .filter((c) => c.bays >= 0)
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
    if (bay_weeks.length === 0) {
      setError('enter or paste at least one weekly bay value')
      return
    }
    try {
      setError(null)
      setMessage(null)
      const saved = editingId
        ? await api.updateFactory(editingId, name, 0, form.changeoverDays, [], bay_weeks)
        : await api.createFactory(scenarioId, name, 0, form.changeoverDays, [], bay_weeks)
      if ((saved.bay_weeks ?? []).length !== bay_weeks.length) {
        setError(
          `Save did not persist weekly bays (${saved.bay_weeks?.length ?? 0}/${bay_weeks.length} returned). Restart the backend so the weekly-bay API/migration is active, then try again.`,
        )
        return
      }
      setEditingId(null)
      setForm(emptyForm())
      setMessage(`Saved ${name} with ${bay_weeks.length} weekly bay value${bay_weeks.length === 1 ? '' : 's'}.`)
      await reload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? (editingId ? 'update failed' : 'create failed'))
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete factory?')) return
    try {
      await api.deleteFactory(id)
      if (editingId === id) cancelEdit()
      await reload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'delete failed')
    }
  }

  function updateOrderCell(rowIndex: number, field: keyof OrderGridRow, value: string) {
    setOrderRows((rows) => {
      const next = rows.slice()
      while (next.length <= rowIndex) next.push(blankOrderRow())
      next[rowIndex] = { ...next[rowIndex], [field]: value }
      const normalized = ensureBlankOrderRows(next)
      scheduleOrderSave(normalized)
      return normalized
    })
  }

  function handleOrderPaste(e: React.ClipboardEvent<HTMLInputElement>, rowIndex: number, colIndex: number) {
    const pasted = splitOrderClipboard(e.clipboardData.getData('text'))
    if (pasted.length === 0) return
    e.preventDefault()
    const fields: Array<keyof OrderGridRow> = ['utid', 'build_type', 'customer', 'cycle_time_days']
    setOrderRows((rows) => {
      const next = rows.slice()
      while (next.length < rowIndex + pasted.length) next.push(blankOrderRow())
      for (let r = 0; r < pasted.length; r++) {
        const target = { ...next[rowIndex + r] }
        for (let c = 0; c < pasted[r].length && colIndex + c < fields.length; c++) {
          target[fields[colIndex + c]] = pasted[r][c]
        }
        next[rowIndex + r] = target
      }
      const normalized = ensureBlankOrderRows(next)
      scheduleOrderSave(normalized)
      return normalized
    })
  }

  async function handleSaveOrders() {
    if (orderSaveTimerRef.current) clearTimeout(orderSaveTimerRef.current)
    orderSaveRequestRef.current++
    const parsed = parseOrderGridRows(orderRows)
    if (parsed.length === 0) {
      setError('enter rows with UTID, Customer, and Cycle Time in Days')
      return
    }
    try {
      setError(null)
      const saved = await api.replaceOrders(scenarioId, parsed)
      setOrders(saved)
      setOrderRows(orderRowsFromSaved(saved))
      setMessage(`Saved ${saved.length} plan row${saved.length === 1 ? '' : 's'}.`)
      return saved
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'failed to save plan rows')
      return null
    }
  }

  function selectedAnchorUtids() {
    const selectedIndices = selectedRows.size > 0
      ? Array.from(selectedRows)
      : orderRows.map((_, i) => i).filter((i) => orderRows[i].utid || orderRows[i].customer)
    return selectedIndices.map((i) => orderRows[i].utid.trim()).filter(Boolean)
  }

  function openAnchorDialog() {
    const selectedUtids = selectedAnchorUtids()
    if (selectedUtids.length === 0) {
      setError('No rows selected or no valid rows to anchor')
      return
    }
    setError(null)
    setAnchorDialogOpen(true)
  }

  async function submitAnchor() {
    const date = anchorDate.trim()
    if (!date) {
      setError('Enter a ship date to anchor selected rows')
      return
    }

    const selectedUtids = selectedAnchorUtids()
    if (selectedUtids.length === 0) {
      setError('No rows selected or no valid rows to anchor')
      return
    }

    try {
      const updatedOrderRows = orderRows.map((r) =>
        selectedUtids.includes(r.utid.trim())
          ? { ...r, due_date: date, anchor_factory_id: anchorFactoryId || undefined }
          : r,
      )
      const parsed = parseOrderGridRows(updatedOrderRows)
      const saved = await api.replaceOrders(scenarioId, parsed)

      setOrders(saved)
      setOrderRows(orderRowsFromSaved(saved))
      setAnchorStatuses({})
      const anchorFactory = factories.find((f) => f.id === anchorFactoryId)?.name
      setMessage(`Anchored ${selectedUtids.length} row${selectedUtids.length === 1 ? '' : 's'} to ${date}${anchorFactory ? ` at ${anchorFactory}` : ''}`)
      setSelectedRows(new Set())
      setAnchorDialogOpen(false)
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'failed to anchor rows')
    }
  }

  async function handleClearPlan() {
    if (selectedRows.size === 0) {
      setError('Select rows to clear')
      return
    }
    const selectedCount = selectedRows.size
    if (!confirm(`Clear ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}? This cannot be undone.`)) return
    try {
      setError(null)
      const keptRows = orderRows.filter((_, i) => !selectedRows.has(i))
      const saved = await api.replaceOrders(scenarioId, parseOrderGridRows(keptRows))
      setOrders(saved)
      setOrderRows(orderRowsFromSaved(saved))
      setAnchorStatuses({})
      setMessage(`Cleared ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}`)
      setSelectedRows(new Set())
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'failed to clear selected rows')
    }
  }

  function getAnchorStatus(utid: string, dueDate?: string): { isLate: boolean; targetDueDate?: string; actualFinish?: string; requiredStart?: string } {
    if (!dueDate) return { isLate: false }
    const status = anchorStatuses[utid]
    const targetDueDate = status?.target_due_date ?? dueDate
    const actualFinish = status?.scheduled_finish
    const isLate = (status?.is_late ?? false) || Boolean(actualFinish && actualFinish > targetDueDate)
    return {
      isLate,
      targetDueDate,
      actualFinish,
      requiredStart: status?.required_start,
    }
  }

  async function handleRunPlan() {
    setRunning(true)
    setError(null)
    try {
      const savedOrders = (await handleSaveOrders()) ?? orders
      const factoryList = await api.listFactories(scenarioId)
      const result = await api.runScenario(
        scenarioId,
        'balance',
        maxStartsPerWeek > 0 ? maxStartsPerWeek : null,
        factorySpacingLimits,
        globalLeadTimePct,
        factoryLeadTimeLimits,
        globalLeadTimeDays,
        factoryLeadTimeDayLimits,
      )
      const statusList = await api.listAnchorStatuses(scenarioId)
      setAnchorStatuses(Object.fromEntries(statusList.map((s) => [s.utid, s])))
      onResult?.(result, { factories: factoryList, products: [], orders: savedOrders })
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-rose-600">{error}</div>}
      {message && <div className="text-sm text-emerald-700">{message}</div>}

      {anchorDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">Anchor selected rows</div>
                <div className="text-xs text-slate-500">Set a ship date and optionally pin the work to one factory.</div>
              </div>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setAnchorDialogOpen(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Ship date</span>
                <input
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                />
              </label>
              <label className="block text-sm">
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Factory</span>
                <select
                  value={anchorFactoryId}
                  onChange={(e) => setAnchorFactoryId(e.target.value)}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">Any factory</option>
                  {factories.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-slate-500">
                Rows selected: {selectedAnchorUtids().length || orderRows.filter((r) => r.utid || r.customer).length}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded border border-slate-300 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setAnchorDialogOpen(false)}>
                Cancel
              </button>
              <button className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600 text-sm text-white hover:bg-indigo-700" onClick={submitAnchor}>
                <Anchor className="w-4 h-4" />
                Anchor
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Factory</th>
              <th className="text-left px-3 py-2 font-medium w-32">Changeover days</th>
              <th className="text-left px-3 py-2 font-medium">Weekly bays</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {factories.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                  No factories yet.
                </td>
              </tr>
            )}
            {factories.map((f) => (
              <tr key={f.id} className={editingId === f.id ? 'bg-indigo-50' : undefined}>
                <td className="px-3 py-2 font-medium">{f.name}</td>
                <td className="px-3 py-2">{f.changeover_days ?? 0}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{weekSummary(f)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <button className="text-indigo-500 hover:text-indigo-700" onClick={() => startEdit(f)} title="Edit">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button className="text-rose-500 hover:text-rose-700" onClick={() => handleDelete(f.id)} title="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div
          ref={formRef}
          className={
            'border-t px-3 py-3 space-y-3 ' +
            (editingId ? 'border-indigo-200 bg-indigo-50/60' : 'border-slate-200 bg-slate-50')
          }
        >
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {editingId ? 'Edit factory' : 'Add factory'}
            </div>
            {editingId && (
              <button className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={cancelEdit}>
                <X className="w-3.5 h-3.5" />
                Cancel edit
              </button>
            )}
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[12rem]">
              <label className="block text-xs text-slate-500 mb-1">Name</label>
              <input
                className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
                placeholder="Factory name…"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Changeover days</label>
              <input
                type="number"
                min={0}
                className="w-32 border border-slate-300 rounded px-2 py-1 text-sm text-center"
                value={form.changeoverDays}
                onChange={(e) => setForm((f) => ({ ...f, changeoverDays: parseInt(e.target.value) || 0 }))}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-3 text-sm mb-2 flex-wrap">
              <span className="text-xs text-slate-500">Weekly bay availability. Start week:</span>
              <input
                type="text"
                className="w-32 border border-slate-300 rounded px-2 py-1 text-sm"
                placeholder="8/2/26"
                value={weekRange.start}
                onBlur={normalizeStartWeek}
                onChange={(e) => setWeekRange((r) => ({ ...r, start: e.target.value }))}
              />
              <span className="text-slate-500">weeks</span>
              <input
                type="number"
                min={1}
                max={260}
                className="w-20 border border-slate-300 rounded px-2 py-1 text-sm"
                value={weekRange.count}
                onChange={(e) => setWeekRange((r) => ({ ...r, count: parseInt(e.target.value) || r.count }))}
              />
              <span className="text-xs text-slate-500">
                Paste 129 values into the first weekly cell; spaces, tabs, rows, or commas all work.
              </span>
            </div>
            {!weekStartIso && <div className="text-xs text-rose-600 mb-2">Start week must look like 8/2/26 or 2026-08-02.</div>}
            <div className="overflow-x-auto">
              <table className="text-xs border border-slate-200 bg-white">
                <thead className="bg-slate-50">
                  <tr>
                    {weeks.map((w) => (
                      <th key={w} className="px-2 py-1 font-medium text-slate-600 min-w-24 text-center">
                        {w}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-200">
                    {weeks.map((w, i) => {
                      const cell = form.weekMatrix[w]
                      return (
                        <td key={w} className="px-1 py-1">
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="bays"
                            className="w-20 border border-slate-200 rounded px-2 py-1 text-center"
                            value={cell?.bays ?? ''}
                            onPaste={(e) => handleWeekPaste(e, i)}
                            onChange={(e) => {
                              const v = e.target.value.trim()
                              setForm((x) => {
                                const next = { ...x, weekMatrix: { ...x.weekMatrix } }
                                if (v === '') delete next.weekMatrix[w]
                                else {
                                  const n = parseNumberCell(v)
                                  if (n != null) next.weekMatrix[w] = { week_start: w, bays: n }
                                }
                                return next
                              })
                            }}
                          />
                        </td>
                      )
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            {showWeeklyGraph && (
              <div className="mt-4 p-4 border border-slate-200 rounded-lg bg-slate-50">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Weekly Bay Availability</h3>
                <Suspense fallback={<div className="h-[300px] animate-pulse rounded bg-slate-100" />}>
                  <Plot
                    data={weeklyGraphData}
                    layout={weeklyGraphLayout}
                    config={{ responsive: true, displayModeBar: false }}
                  />
                </Suspense>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700" onClick={handleSubmit}>
              {editingId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {editingId ? 'Save changes' : 'Add factory'}
            </button>
            {editingId && (
              <button className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 bg-white text-slate-700 text-sm rounded hover:bg-slate-50" onClick={cancelEdit}>
                Cancel
              </button>
            )}
            {Object.keys(form.weekMatrix).length > 0 && (
              <button 
                className="inline-flex items-center gap-1 px-3 py-1.5 border border-indigo-300 bg-indigo-50 text-indigo-700 text-sm rounded hover:bg-indigo-100 font-medium"
                onClick={() => setShowWeeklyGraph(!showWeeklyGraph)}
              >
                <BarChart3 className="w-4 h-4" />
                {showWeeklyGraph ? 'Hide' : 'View'} Graph
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Plan</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 bg-white text-slate-700 text-sm rounded hover:bg-slate-50"
              onClick={openAnchorDialog}
              title="Anchor selected rows to a ship date and optional factory (auto-saves)"
            >
              <Anchor className="w-4 h-4" />
              Anchor
            </button>
            <button
              className="inline-flex items-center gap-1 px-3 py-1.5 border border-rose-300 bg-white text-rose-700 text-sm rounded hover:bg-rose-50"
              onClick={handleClearPlan}
              title="Clear selected plan rows"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </button>
            <button
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 disabled:opacity-50"
              onClick={handleRunPlan}
              disabled={running}
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {running ? 'Running…' : 'Run plan'}
            </button>
          </div>
        </div>
        <div className="space-y-3 text-xs text-slate-600">
          <div className="flex flex-col gap-2">
            <label className="block text-slate-500 text-center">Schedule spacing</label>
            <Dial
              value={maxStartsPerWeek}
              onChange={setMaxStartsPerWeek}
              min={1}
              max={20}
            />
            {factories.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Factory spacing overrides</div>
                    <div className="text-[11px] text-slate-500">Blank uses the global switch value for that factory.</div>
                  </div>
                  {Object.keys(factorySpacingOverrides).length > 0 && (
                    <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setFactorySpacingOverrides({})}>
                      Reset
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {factories.map((f) => (
                    <label key={f.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5">
                      <span className="truncate text-xs font-medium text-slate-700" title={f.name}>{f.name}</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        placeholder={`${maxStartsPerWeek}/wk`}
                        value={factorySpacingOverrides[f.id] ?? ''}
                        onChange={(e) => setFactorySpacingOverrides((prev) => {
                          const next = { ...prev }
                          if (e.target.value) next[f.id] = e.target.value
                          else delete next[f.id]
                          return next
                        })}
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-xs focus:border-indigo-400 focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lead-time adjustment</div>
                  <div className="text-[11px] text-slate-500">Applied to cycle time as percent first, then fixed days. Positive adds time; negative reduces time.</div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    Global
                    <input
                      type="number"
                      step={1}
                      min={-95}
                      max={500}
                      value={leadTimePct}
                      onChange={(e) => setLeadTimePct(e.target.value)}
                      className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-xs focus:border-indigo-400 focus:outline-none"
                    />
                    %
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    plus
                    <input
                      type="number"
                      step={1}
                      min={-365}
                      max={3650}
                      value={leadTimeDays}
                      onChange={(e) => setLeadTimeDays(e.target.value)}
                      className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-xs focus:border-indigo-400 focus:outline-none"
                    />
                    days
                  </label>
                </div>
              </div>
              {factories.length > 0 && (
                <>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-[11px] text-slate-500">Optional per-factory overrides. Blank uses the global values.</div>
                    {(Object.keys(factoryLeadTimeOverrides).length > 0 || Object.keys(factoryLeadTimeDayOverrides).length > 0) && (
                      <button
                        className="text-xs text-slate-500 hover:text-slate-800"
                        onClick={() => {
                          setFactoryLeadTimeOverrides({})
                          setFactoryLeadTimeDayOverrides({})
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {factories.map((f) => (
                      <label key={f.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5">
                        <span className="truncate text-xs font-medium text-slate-700" title={f.name}>{f.name}</span>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            step={1}
                            min={-95}
                            max={500}
                            placeholder={`${globalLeadTimePct}%`}
                            value={factoryLeadTimeOverrides[f.id] ?? ''}
                            onChange={(e) => setFactoryLeadTimeOverrides((prev) => {
                              const next = { ...prev }
                              if (e.target.value) next[f.id] = e.target.value
                              else delete next[f.id]
                              return next
                            })}
                            className="w-16 rounded border border-slate-300 px-2 py-1 text-right text-xs focus:border-indigo-400 focus:outline-none"
                          />
                          <span className="text-[11px] text-slate-400">%</span>
                          <input
                            type="number"
                            step={1}
                            min={-365}
                            max={3650}
                            placeholder={`${globalLeadTimeDays}d`}
                            value={factoryLeadTimeDayOverrides[f.id] ?? ''}
                            onChange={(e) => setFactoryLeadTimeDayOverrides((prev) => {
                              const next = { ...prev }
                              if (e.target.value) next[f.id] = e.target.value
                              else delete next[f.id]
                              return next
                            })}
                            className="w-16 rounded border border-slate-300 px-2 py-1 text-right text-xs focus:border-indigo-400 focus:outline-none"
                          />
                          <span className="text-[11px] text-slate-400">d</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div>
            {capacitySummary ? (
              <span>
                Capacity horizon: {capacitySummary.first} → {capacitySummary.last} ({capacitySummary.weekCount} weeks).{' '}
                Plan rows: {capacitySummary.plannedRows}. Auto cadence: {capacitySummary.autoStarts}/week. The switch applies to every factory by default; use overrides for distinct factory spacing and lead-time adjustments.
              </span>
            ) : (
              <span>Save weekly factory bays to define the capacity horizon.</span>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-500">Saved rows: {orders.length}</div>
        <div className="overflow-auto max-h-96 border border-slate-200 rounded">
          <table className="min-w-full text-xs bg-white">
            <thead className="bg-slate-50 text-slate-600 sticky top-0">
              <tr>
                <th className="w-10 px-2 py-1 text-center font-medium">
                  <input
                    type="checkbox"
                    checked={selectedRows.size > 0 && selectedRows.size === orderRows.filter((r) => r.utid || r.customer).length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedRows(new Set(orderRows.map((_, i) => i).filter((i) => orderRows[i].utid || orderRows[i].customer)))
                      } else {
                        setSelectedRows(new Set())
                      }
                    }}
                  />
                </th>
                <th className="w-12 px-2 py-1 text-right font-medium">#</th>
                <th className="text-left px-2 py-1 font-medium min-w-40">UTID</th>
                <th className="text-left px-2 py-1 font-medium min-w-40">Build Type</th>
                <th className="text-left px-2 py-1 font-medium min-w-48">Customer</th>
                <th className="text-left px-2 py-1 font-medium min-w-36">Cycle Time in Days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orderRows.map((row, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 text-center bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(i)}
                      onChange={(e) => {
                        const newSelected = new Set(selectedRows)
                        if (e.target.checked) {
                          newSelected.add(i)
                        } else {
                          newSelected.delete(i)
                        }
                        setSelectedRows(newSelected)
                      }}
                    />
                  </td>
                  <td className="px-2 py-1 text-right text-slate-400 bg-slate-50">{i + 1}</td>
                  <td className="px-1 py-1">
                    <div className="flex items-center gap-1">
                      {row.utid && row.due_date && (() => {
                        const status = getAnchorStatus(row.utid, row.due_date)
                        const anchorFactory = factories.find((f) => f.id === row.anchor_factory_id)?.name
                        const tooltip = `Target due: ${status.targetDueDate}${anchorFactory ? `\nFactory: ${anchorFactory}` : ''}${status.requiredStart ? `\nRequired start: ${status.requiredStart}` : ''}${status.actualFinish ? `\nScheduled finish: ${status.actualFinish}` : ''}${status.isLate ? '\nMISSED DUE DATE' : ''}`
                        return (
                          <div
                            className={`group relative flex-shrink-0 flex items-center gap-1 rounded px-0.5 ${status.isLate ? 'bg-red-100 ring-1 ring-red-300' : ''}`}
                            title={tooltip}
                          >
                            <Anchor className={`w-3.5 h-3.5 ${status.isLate ? 'text-red-600' : 'text-indigo-500'}`} />
                            {status.isLate && <span className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
                            <button
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-rose-600 p-0.5"
                              onClick={async () => {
                                try {
                                  const updated = await api.removeAnchor(scenarioId, row.utid)
                                  setOrders(updated)
                                  setOrderRows(orderRowsFromSaved(updated))
                                  setAnchorStatuses((statuses) => {
                                    const next = { ...statuses }
                                    delete next[row.utid]
                                    return next
                                  })
                                  setMessage(`Removed anchor from ${row.utid}`)
                                } catch (e: unknown) {
                                  setError(((e as { message?: string }).message) ?? 'failed to remove anchor')
                                }
                              }}
                              title="Remove anchor"
                            >
                              <X className="w-3 h-3" />
                            </button>
                            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                              <div>Target due: {status.targetDueDate}</div>
                              {anchorFactory && <div>Factory: {anchorFactory}</div>}
                              {status.requiredStart && <div>Required start: {status.requiredStart}</div>}
                              {status.actualFinish && <div>Scheduled finish: {status.actualFinish}</div>}
                              {status.isLate && <div className="text-red-300 font-semibold">MISSED DUE DATE</div>}
                            </div>
                          </div>
                        )
                      })()}
                      <input
                        className="w-full border border-slate-200 rounded px-2 py-1"
                        value={row.utid}
                        onPaste={(e) => handleOrderPaste(e, i, 0)}
                        onChange={(e) => updateOrderCell(i, 'utid', e.target.value)}
                      />
                    </div>
                  </td>
                  <td className="px-1 py-1">
                    <input
                      className="w-full border border-slate-200 rounded px-2 py-1"
                      value={row.build_type}
                      onPaste={(e) => handleOrderPaste(e, i, 1)}
                      onChange={(e) => updateOrderCell(i, 'build_type', e.target.value)}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      className="w-full border border-slate-200 rounded px-2 py-1"
                      value={row.customer}
                      onPaste={(e) => handleOrderPaste(e, i, 2)}
                      onChange={(e) => updateOrderCell(i, 'customer', e.target.value)}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      className="w-full border border-slate-200 rounded px-2 py-1 text-right"
                      value={row.cycle_time_days}
                      onPaste={(e) => handleOrderPaste(e, i, 3)}
                      onChange={(e) => updateOrderCell(i, 'cycle_time_days', e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

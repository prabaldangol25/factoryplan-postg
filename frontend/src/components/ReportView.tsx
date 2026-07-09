import { useMemo, useState } from 'react'
import { Copy, Check, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { Factory, Product, RunResult, ScenarioOrder } from '../types'

interface Props {
  result: RunResult | null
  context: { factories: Factory[]; products: Product[]; orders?: ScenarioOrder[] } | null
  onGoToRun: () => void
}

type ColType = 'string' | 'date' | 'quarter'

interface ColumnDef {
  key: ReportRowKey
  label: string
  type: ColType
}

interface ReportRow {
  serial: string
  buildType: string
  customer: string
  factory: string
  quarter: string
  shipDate: string
  startDate: string
  late: boolean
}

type ReportRowKey =
  | 'serial'
  | 'buildType'
  | 'customer'
  | 'factory'
  | 'quarter'
  | 'shipDate'
  | 'startDate'

const COLUMN_DEFS: ColumnDef[] = [
  { key: 'serial', label: 'UTID', type: 'string' },
  { key: 'buildType', label: 'Build Type', type: 'string' },
  { key: 'customer', label: 'Customer', type: 'string' },
  { key: 'factory', label: 'Factory', type: 'string' },
  { key: 'quarter', label: 'Shipping quarter', type: 'quarter' },
  { key: 'shipDate', label: 'Ship date', type: 'date' },
  { key: 'startDate', label: 'Start date', type: 'date' },
]

const COLUMNS = COLUMN_DEFS.map((c) => c.label)

type SortDir = 'asc' | 'desc' | null

function quarterLabel(due: string): string {
  const month = parseInt(due.slice(5, 7), 10)
  if (!month) return ''
  const q = Math.floor((month - 1) / 3) + 1
  return `${due.slice(0, 4)} Q${q}`
}

// Convert a "2026 Q3" style label into a comparable number (year * 10 + quarter).
function quarterSortValue(label: string): number {
  const m = label.match(/^(\d{4})\s*Q([1-4])$/)
  if (!m) return Number.NaN
  return parseInt(m[1], 10) * 10 + parseInt(m[2], 10)
}

// Compare two rows for a given column, returning a value suitable for asc order.
// Empty values always sort last (regardless of direction handling, they are pushed
// to the end of the ascending order).
function compareValues(a: string, b: string, type: ColType): number {
  const aEmpty = a === ''
  const bEmpty = b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  if (type === 'date') {
    // ISO-ish date strings compare correctly lexicographically.
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (type === 'quarter') {
    const av = quarterSortValue(a)
    const bv = quarterSortValue(b)
    if (Number.isNaN(av) && Number.isNaN(bv)) return 0
    if (Number.isNaN(av)) return 1
    if (Number.isNaN(bv)) return -1
    return av - bv
  }
  return a.toLowerCase().localeCompare(b.toLowerCase())
}

export function ReportView({ result, context, onGoToRun }: Props) {
  const [copied, setCopied] = useState(false)
  const [sortKey, setSortKey] = useState<ReportRowKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})

  const rows = useMemo<ReportRow[]>(() => {
    if (!result || !context) return []
    const fname = new Map(context.factories.map((f) => [f.id, f.name]))
    const orderById = new Map((context.orders ?? []).map((o) => [o.id, o]))
    return result.units
      .map((u) => {
        const shipped = u.status === 'shipped'
        const order = orderById.get(u.demand_id)
        return {
          serial: u.serial ?? '',
          buildType: order?.build_type ?? '',
          customer: order?.customer ?? u.product_id,
          factory: shipped && u.factory_id ? fname.get(u.factory_id) ?? '' : '',
          quarter: quarterLabel(u.due_date),
          shipDate: u.due_date,
          startDate: shipped ? u.required_start : '',
          late: u.is_late,
        }
      })
      .sort((a, b) =>
        a.shipDate === b.shipDate
          ? a.serial.localeCompare(b.serial)
          : a.shipDate.localeCompare(b.shipDate),
      )
  }, [result, context])

  const hasActiveFilter = useMemo(
    () => Object.values(filters).some((v) => v && v !== '' && v !== 'All'),
    [filters],
  )

  const visibleRows = useMemo<ReportRow[]>(() => {
    // Filtering
    let out = rows.filter((r) =>
      COLUMN_DEFS.every((col) => {
        const f = filters[col.key]
        if (!f) return true
        return String(r[col.key]).toLowerCase().includes(f.toLowerCase())
      }),
    )

    // Sorting
    if (sortKey && sortDir) {
      const def = COLUMN_DEFS.find((c) => c.key === sortKey)
      const type: ColType = def ? def.type : 'string'
      const factor = sortDir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => {
        const av = String(a[sortKey])
        const bv = String(b[sortKey])
        const cmp = compareValues(av, bv, type)
        // Keep empty values last for desc too: compareValues already pushes empties
        // to the end of asc order; multiply by factor flips non-empty ordering but we
        // re-handle empties so they remain last.
        const aEmpty = av === ''
        const bEmpty = bv === ''
        if (aEmpty && bEmpty) return 0
        if (aEmpty) return 1
        if (bEmpty) return -1
        return cmp * factor
      })
    }

    return out
  }, [rows, filters, sortKey, sortDir])

  function cycleSort(key: ReportRowKey) {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    // same column: asc -> desc -> none
    if (sortDir === 'asc') {
      setSortDir('desc')
    } else if (sortDir === 'desc') {
      setSortKey(null)
      setSortDir(null)
    } else {
      setSortDir('asc')
    }
  }

  function setFilter(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  async function copyForExcel() {
    const tsv = [
      COLUMNS.join('\t'),
      ...visibleRows.map((r) =>
        [
          r.serial,
          r.buildType,
          r.customer,
          r.factory,
          r.quarter,
          r.shipDate,
          r.startDate,
        ].join('\t'),
      ),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(tsv)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea')
      ta.value = tsv
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  if (!result || !context) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500 text-sm">
        No results yet.{' '}
        <button className="text-indigo-600 hover:underline" onClick={onGoToRun}>
          Go to the Run tab
        </button>{' '}
        to compute a schedule, then come back here.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-slate-600">
          {hasActiveFilter ? (
            <>
              {visibleRows.length} of {rows.length} unit{rows.length !== 1 && 's'}
            </>
          ) : (
            <>
              {rows.length} unit{rows.length !== 1 && 's'}
            </>
          )}{' '}
          · select the table or use the button to copy into Excel.
        </div>
        <button
          onClick={copyForExcel}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy for Excel'}
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-auto max-h-[70vh]">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10">
            <tr>
              {COLUMN_DEFS.map((col) => {
                const active = sortKey === col.key && sortDir
                return (
                  <th
                    key={col.key}
                    className="text-left px-3 py-2 font-medium whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => cycleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      {col.label}
                      {active === 'asc' ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : active === 'desc' ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronsUpDown className="w-3.5 h-3.5 text-slate-400" />
                      )}
                    </button>
                  </th>
                )
              })}
            </tr>
            <tr className="bg-slate-50">
              {COLUMN_DEFS.map((col) => (
                <th key={col.key} className="px-2 py-1.5 font-normal align-top">
                  <input
                    type="text"
                    value={filters[col.key] ?? ''}
                    onChange={(e) => setFilter(col.key, e.target.value)}
                    placeholder="Filter…"
                    className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-1.5 font-mono text-xs">{r.serial}</td>
                <td className="px-3 py-1.5">{r.buildType}</td>
                <td className="px-3 py-1.5">{r.customer}</td>
                <td className="px-3 py-1.5">{r.factory}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.quarter}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.shipDate}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.startDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

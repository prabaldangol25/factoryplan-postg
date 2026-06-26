import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, ChevronDown, ChevronRight } from 'lucide-react'
import type { Factory, Product } from '../types'
import * as api from '../api'

interface Props {
  scenarioId: string
}

interface LtCell {
  year: number
  quarter: number
  lead_time_days: number
}

interface AllocationCell {
  factory_id: string
  allocation_pct: number
}

interface Draft {
  name: string
  /** Base per-(year, quarter) lead-time matrix. */
  matrix: Record<string, LtCell>
  /** Whether per-factory overrides are enabled for this product. */
  useFactory: boolean
  /** factory_id -> per-(year, quarter) override matrix. */
  factoryMatrix: Record<string, Record<string, LtCell>>
  /** Whether product-to-factory allocation rules are enabled. */
  useAllocation: boolean
  /** "global" or "YYYY-QN" -> selected factory and target percentage. */
  allocationMatrix: Record<string, AllocationCell>
}

function ltKey(year: number, quarter: number) {
  return `${year}-Q${quarter}`
}

function allocationKey(year: number, quarter: number) {
  return `${year}-Q${quarter}`
}

function emptyDraft(name = ''): Draft {
  return {
    name,
    matrix: {},
    useFactory: false,
    factoryMatrix: {},
    useAllocation: false,
    allocationMatrix: {},
  }
}

function leadTimesFromMatrix(matrix: Record<string, LtCell>): api.LeadTimeInput[] {
  return Object.values(matrix).filter((c) => c.lead_time_days > 0)
}

function parseClipboardGrid(text: string): string[][] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((row) => row.length > 0)
    .map((row) => row.split('\t'))
}

function applyLtGridPaste(
  matrix: Record<string, LtCell>,
  startYear: number,
  startQuarter: number,
  text: string,
): Record<string, LtCell> {
  const next = { ...matrix }
  for (const [rowIndex, row] of parseClipboardGrid(text).entries()) {
    for (const [colIndex, raw] of row.entries()) {
      const quarterOffset = startQuarter - 1 + colIndex
      const year = startYear + rowIndex + Math.floor(quarterOffset / 4)
      const quarter = (quarterOffset % 4) + 1
      const key = ltKey(year, quarter)
      const value = parseInt(raw.trim(), 10)
      if (!value || value <= 0) delete next[key]
      else next[key] = { year, quarter, lead_time_days: value }
    }
  }
  return next
}

export function ProductEditor({ scenarioId }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [factories, setFactories] = useState<Factory[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [newDraft, setNewDraft] = useState<Draft>(() => emptyDraft())
  const [yearRange, setYearRange] = useState<{ from: number; to: number }>(() => {
    const y = new Date().getFullYear()
    return { from: y, to: y + 1 }
  })

  async function reload() {
    try {
      setError(null)
      const [list, facs] = await Promise.all([
        api.listProducts(scenarioId),
        api.listFactories(scenarioId),
      ])
      setProducts(list)
      setFactories(facs)
      const savedYears = list.flatMap((p) => [
        ...p.lead_times.map((lt) => lt.year),
        ...(p.factory_lead_times ?? []).map((lt) => lt.year),
        ...(p.factory_allocations ?? []).filter((a) => a.year > 0).map((a) => a.year),
      ])
      if (savedYears.length > 0) {
        setYearRange((r) => ({
          from: Math.min(r.from, ...savedYears),
          to: Math.max(r.to, ...savedYears),
        }))
      }
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'load failed')
    }
  }
  useEffect(() => {
    setProducts([])
    setFactories([])
    setExpanded({})
    setDrafts({})
    setNewDraft(emptyDraft())
    if (scenarioId) void reload()
  }, [scenarioId])

  function initDraft(p: Product): Draft {
    const matrix: Record<string, LtCell> = {}
    for (const lt of p.lead_times) {
      matrix[ltKey(lt.year, lt.quarter)] = {
        year: lt.year,
        quarter: lt.quarter,
        lead_time_days: lt.lead_time_days,
      }
    }
    // Seed a (stable-ordered) empty matrix per factory, then fill overrides.
    // `factory_lead_times` may be absent if served by an older backend build.
    const factoryLeadTimes = p.factory_lead_times ?? []
    const factoryMatrix: Record<string, Record<string, LtCell>> = {}
    for (const f of factories) factoryMatrix[f.id] = {}
    for (const lt of factoryLeadTimes) {
      if (!factoryMatrix[lt.factory_id]) factoryMatrix[lt.factory_id] = {}
      factoryMatrix[lt.factory_id][ltKey(lt.year, lt.quarter)] = {
        year: lt.year,
        quarter: lt.quarter,
        lead_time_days: lt.lead_time_days,
      }
    }
    const factoryAllocations = p.factory_allocations ?? []
    const allocationMatrix: Record<string, AllocationCell> = {}
    for (const a of factoryAllocations) {
      allocationMatrix[a.year === 0 && a.quarter === 0 ? 'global' : allocationKey(a.year, a.quarter)] = {
        factory_id: a.factory_id,
        allocation_pct: a.allocation_pct,
      }
    }
    return {
      name: p.name,
      matrix,
      useFactory: factoryLeadTimes.length > 0,
      factoryMatrix,
      useAllocation: factoryAllocations.length > 0,
      allocationMatrix,
    }
  }

  function draftFor(p: Product) {
    return drafts[p.id] ?? initDraft(p)
  }
  function setDraft(id: string, fn: (d: Draft) => Draft) {
    setDrafts((s) => {
      const current = s[id] ?? initDraft(products.find((p) => p.id === id)!)
      return { ...s, [id]: fn(current) }
    })
  }

  async function handleCreate() {
    if (!newDraft.name.trim()) {
      setError('Enter a product name first.')
      return
    }
    const lts = leadTimesFromMatrix(newDraft.matrix)
    try {
      await api.createProduct(scenarioId, newDraft.name.trim(), lts)
      setNewDraft(emptyDraft())
      setError(null)
      await reload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'create failed')
    }
  }

  async function handleSave(p: Product) {
    const d = draftFor(p)
    const lts = leadTimesFromMatrix(d.matrix)
    const factoryLts = d.useFactory
      ? Object.entries(d.factoryMatrix).flatMap(([factory_id, m]) =>
          Object.values(m)
            .filter((c) => c.lead_time_days > 0)
            .map((c) => ({
              factory_id,
              year: c.year,
              quarter: c.quarter,
              lead_time_days: c.lead_time_days,
            })),
        )
      : []
    const factoryAllocations = d.useAllocation
      ? Object.entries(d.allocationMatrix)
          .filter(([, c]) => c.factory_id && c.allocation_pct >= 0 && c.allocation_pct <= 100)
          .map(([k, c]) => {
            if (k === 'global') {
              return {
                factory_id: c.factory_id,
                year: 0,
                quarter: 0,
                allocation_pct: c.allocation_pct,
              }
            }
            const [yearPart, qPart] = k.split('-Q')
            return {
              factory_id: c.factory_id,
              year: parseInt(yearPart, 10),
              quarter: parseInt(qPart, 10),
              allocation_pct: c.allocation_pct,
            }
          })
      : []
    try {
      const updated = await api.updateProduct(p.id, d.name.trim(), lts, factoryLts, factoryAllocations)
      if (
        d.useAllocation &&
        factoryAllocations.length > 0 &&
        (updated.factory_allocations?.length ?? 0) === 0
      ) {
        setError(
          'Allocation settings were sent, but the backend did not return saved allocations. Restart the backend so migration 0007 is applied.',
        )
        return
      }
      setDrafts((s) => {
        const x = { ...s }
        delete x[p.id]
        return x
      })
      await reload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'save failed')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete product?')) return
    try {
      await api.deleteProduct(id)
      await reload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'delete failed')
    }
  }

  const years: number[] = []
  for (let y = yearRange.from; y <= yearRange.to; y++) years.push(y)

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-rose-600">{error}</div>}

      <div className="flex items-center gap-3 text-sm">
        <span className="text-slate-600">Lead-time matrix years:</span>
        <input
          type="number"
          className="w-20 border border-slate-300 rounded px-2 py-1"
          value={yearRange.from}
          onChange={(e) =>
            setYearRange((r) => ({ ...r, from: parseInt(e.target.value) || r.from }))
          }
        />
        <span className="text-slate-500">to</span>
        <input
          type="number"
          className="w-20 border border-slate-300 rounded px-2 py-1"
          value={yearRange.to}
          onChange={(e) => setYearRange((r) => ({ ...r, to: parseInt(e.target.value) || r.to }))}
        />
        <button
          type="button"
          className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50"
          onClick={() => setYearRange((r) => ({ ...r, from: r.from - 1 }))}
        >
          Add previous year
        </button>
        <button
          type="button"
          className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50"
          onClick={() => setYearRange((r) => ({ ...r, to: r.to + 1 }))}
        >
          Add next year
        </button>
      </div>

      <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-indigo-700">Add product</div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[14rem]">
            <label className="block text-xs text-slate-500 mb-1">Product name</label>
            <input
              autoFocus
              aria-label="New product name"
              className="w-full border border-indigo-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder="New product name…"
              value={newDraft.name}
              onChange={(e) => setNewDraft((d) => ({ ...d, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
            />
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
            onClick={handleCreate}
          >
            <Plus className="w-4 h-4" />
            Add product
          </button>
        </div>
        <div className="overflow-x-auto">
          <div className="text-xs font-medium text-slate-500 mb-1">
            Default lead time (days) to save with the new product
          </div>
          <table className="text-sm border border-slate-200 bg-white">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-600">Year</th>
                {[1, 2, 3, 4].map((q) => (
                  <th key={q} className="px-2 py-1 font-medium text-slate-600 w-24 text-center">
                    Q{q}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y} className="border-t border-slate-200">
                  <td className="px-2 py-1 font-medium">{y}</td>
                  {[1, 2, 3, 4].map((q) => {
                    const k = ltKey(y, q)
                    const cell = newDraft.matrix[k]
                    return (
                      <td key={q} className="px-1 py-1">
                        <input
                          type="number"
                          min={0}
                          placeholder="days"
                          className="w-20 border border-slate-200 rounded px-2 py-1 text-center"
                          value={cell?.lead_time_days ?? ''}
                          onPaste={(e) => {
                            e.preventDefault()
                            const text = e.clipboardData.getData('text')
                            setNewDraft((d) => ({
                              ...d,
                              matrix: applyLtGridPaste(d.matrix, y, q, text),
                            }))
                          }}
                          onChange={(e) => {
                            const v = parseInt(e.target.value)
                            setNewDraft((d) => {
                              const matrix = { ...d.matrix }
                              if (!v || v <= 0) delete matrix[k]
                              else matrix[k] = { year: y, quarter: q, lead_time_days: v }
                              return { ...d, matrix }
                            })
                          }}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        {products.length === 0 && (
          <div className="px-3 py-6 text-center text-slate-500 text-sm">No products yet.</div>
        )}
        {products.map((p) => {
          const isOpen = expanded[p.id] ?? false
          const d = draftFor(p)
          const dirty =
            drafts[p.id] !== undefined &&
            JSON.stringify(drafts[p.id]) !== JSON.stringify(initDraft(p))
          return (
            <div key={p.id} className="border-b border-slate-100 last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  className="text-slate-500 hover:text-slate-800"
                  onClick={() => setExpanded((e) => ({ ...e, [p.id]: !isOpen }))}
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>
                <input
                  className="flex-1 border border-transparent hover:border-slate-200 rounded px-2 py-1"
                  value={d.name}
                  onChange={(e) => setDraft(p.id, (x) => ({ ...x, name: e.target.value }))}
                />
                {(p.factory_lead_times?.length ?? 0) > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 whitespace-nowrap">
                    factory-specific LT
                  </span>
                )}
                {(p.factory_allocations?.length ?? 0) > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 whitespace-nowrap">
                    factory allocation
                  </span>
                )}
                {dirty && (
                  <button
                    className="text-emerald-700 hover:text-emerald-900"
                    onClick={() => handleSave(p)}
                    title="Save"
                  >
                    <Save className="w-4 h-4" />
                  </button>
                )}
                <button
                  className="text-rose-500 hover:text-rose-700"
                  onClick={() => handleDelete(p.id)}
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {isOpen && (
                <div className="px-3 pb-4 space-y-4">
                  <div className="flex items-center gap-2 text-xs text-slate-600 flex-wrap">
                    <span>Years for this product:</span>
                    <input
                      type="number"
                      className="w-20 border border-slate-300 rounded px-2 py-1"
                      value={yearRange.from}
                      onChange={(e) =>
                        setYearRange((r) => ({ ...r, from: parseInt(e.target.value) || r.from }))
                      }
                    />
                    <span className="text-slate-500">to</span>
                    <input
                      type="number"
                      className="w-20 border border-slate-300 rounded px-2 py-1"
                      value={yearRange.to}
                      onChange={(e) =>
                        setYearRange((r) => ({ ...r, to: parseInt(e.target.value) || r.to }))
                      }
                    />
                    <button
                      type="button"
                      className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50"
                      onClick={() => setYearRange((r) => ({ ...r, from: r.from - 1 }))}
                    >
                      Add previous year
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50"
                      onClick={() => setYearRange((r) => ({ ...r, to: r.to + 1 }))}
                    >
                      Add next year
                    </button>
                    <span className="text-slate-400">Enter lead times in the new year, then save.</span>
                  </div>
                  <div className="overflow-x-auto">
                    <div className="text-xs font-medium text-slate-500 mb-1">
                      Default lead time (days) — applies at every factory unless overridden
                    </div>
                    <table className="text-sm border border-slate-200">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-2 py-1 text-left font-medium text-slate-600">Year</th>
                          {[1, 2, 3, 4].map((q) => (
                            <th
                              key={q}
                              className="px-2 py-1 font-medium text-slate-600 w-24 text-center"
                            >
                              Q{q}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {years.map((y) => (
                          <tr key={y} className="border-t border-slate-200">
                            <td className="px-2 py-1 font-medium">{y}</td>
                            {[1, 2, 3, 4].map((q) => {
                              const k = ltKey(y, q)
                              const cell = d.matrix[k]
                              return (
                                <td key={q} className="px-1 py-1">
                                  <input
                                    type="number"
                                    min={0}
                                    placeholder="days"
                                    className="w-20 border border-slate-200 rounded px-2 py-1 text-center"
                                    value={cell?.lead_time_days ?? ''}
                                    onPaste={(e) => {
                                      e.preventDefault()
                                      const text = e.clipboardData.getData('text')
                                      setDraft(p.id, (x) => ({
                                        ...x,
                                        matrix: applyLtGridPaste(x.matrix, y, q, text),
                                      }))
                                    }}
                                    onChange={(e) => {
                                      const v = parseInt(e.target.value)
                                      setDraft(p.id, (x) => {
                                        const next = { ...x, matrix: { ...x.matrix } }
                                        if (!v || v <= 0) delete next.matrix[k]
                                        else
                                          next.matrix[k] = {
                                            year: y,
                                            quarter: q,
                                            lead_time_days: v,
                                          }
                                        return next
                                      })
                                    }}
                                  />
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={d.useFactory}
                      onChange={(e) =>
                        setDraft(p.id, (x) => ({ ...x, useFactory: e.target.checked }))
                      }
                    />
                    Set factory-specific lead times
                    <span className="text-xs text-slate-400">
                      (leave a cell blank to inherit the default)
                    </span>
                  </label>

                  {d.useFactory && (
                    <div className="space-y-3 pl-1 border-l-2 border-indigo-100">
                      {factories.length === 0 && (
                        <div className="text-sm text-slate-500 pl-3">
                          No factories defined yet — add factories first.
                        </div>
                      )}
                      {factories.map((f) => {
                        const fm = d.factoryMatrix[f.id] ?? {}
                        return (
                          <div key={f.id} className="overflow-x-auto pl-3">
                            <div className="text-xs font-medium text-slate-600 mb-1">{f.name}</div>
                            <table className="text-sm border border-slate-200">
                              <thead className="bg-slate-50">
                                <tr>
                                  <th className="px-2 py-1 text-left font-medium text-slate-600">
                                    Year
                                  </th>
                                  {[1, 2, 3, 4].map((q) => (
                                    <th
                                      key={q}
                                      className="px-2 py-1 font-medium text-slate-600 w-24 text-center"
                                    >
                                      Q{q}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {years.map((y) => (
                                  <tr key={y} className="border-t border-slate-200">
                                    <td className="px-2 py-1 font-medium">{y}</td>
                                    {[1, 2, 3, 4].map((q) => {
                                      const k = ltKey(y, q)
                                      const cell = fm[k]
                                      const base = d.matrix[k]?.lead_time_days
                                      return (
                                        <td key={q} className="px-1 py-1">
                                          <input
                                            type="number"
                                            min={0}
                                            placeholder={base ? `${base}` : 'inherit'}
                                            className="w-20 border border-slate-200 rounded px-2 py-1 text-center"
                                            value={cell?.lead_time_days ?? ''}
                                            onPaste={(e) => {
                                              e.preventDefault()
                                              const text = e.clipboardData.getData('text')
                                              setDraft(p.id, (x) => ({
                                                ...x,
                                                factoryMatrix: {
                                                  ...x.factoryMatrix,
                                                  [f.id]: applyLtGridPaste(
                                                    x.factoryMatrix[f.id] ?? {},
                                                    y,
                                                    q,
                                                    text,
                                                  ),
                                                },
                                              }))
                                            }}
                                            onChange={(e) => {
                                              const v = parseInt(e.target.value)
                                              setDraft(p.id, (x) => {
                                                const fmNext = { ...(x.factoryMatrix[f.id] ?? {}) }
                                                if (!v || v <= 0) delete fmNext[k]
                                                else
                                                  fmNext[k] = {
                                                    year: y,
                                                    quarter: q,
                                                    lead_time_days: v,
                                                  }
                                                return {
                                                  ...x,
                                                  factoryMatrix: {
                                                    ...x.factoryMatrix,
                                                    [f.id]: fmNext,
                                                  },
                                                }
                                              })
                                            }}
                                          />
                                        </td>
                                      )
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={d.useAllocation}
                      onChange={(e) =>
                        setDraft(p.id, (x) => ({
                          ...x,
                          useAllocation: e.target.checked,
                          allocationMatrix:
                            e.target.checked &&
                            Object.keys(x.allocationMatrix).length === 0 &&
                            factories[0]
                              ? {
                                  global: {
                                    factory_id: factories[0].id,
                                    allocation_pct: 100,
                                  },
                                }
                              : x.allocationMatrix,
                        }))
                      }
                    />
                    Set product-to-factory allocation
                    <span className="text-xs text-slate-400">
                      (send a chosen % to one factory; remainder goes to other factories)
                    </span>
                  </label>

                  {d.useAllocation && (
                    <div className="space-y-3 pl-3 border-l-2 border-amber-100">
                      {factories.length === 0 ? (
                        <div className="text-sm text-slate-500">
                          No factories defined yet — add factories first.
                        </div>
                      ) : (
                        <>
                          <div className="text-xs text-slate-500">
                            A global rule applies to all quarters unless a specific quarter below
                            overrides it. Use 100% to force the product to that factory.
                          </div>
                          {[
                            { key: 'global', label: 'All quarters' },
                            ...years.flatMap((y) =>
                              [1, 2, 3, 4].map((q) => ({
                                key: allocationKey(y, q),
                                label: `${y} Q${q}`,
                              })),
                            ),
                          ].map((row) => {
                            const cell = d.allocationMatrix[row.key]
                            const selectedFactory = cell?.factory_id ?? factories[0]?.id ?? ''
                            const pct = cell?.allocation_pct ?? 100
                            return (
                              <div
                                key={row.key}
                                className="grid grid-cols-[7rem_minmax(10rem,14rem)_1fr_4rem_auto] items-center gap-2 text-sm"
                              >
                                <div className="font-medium text-slate-600">{row.label}</div>
                                <select
                                  className="border border-slate-300 rounded px-2 py-1 bg-white"
                                  value={selectedFactory}
                                  onChange={(e) => {
                                    const factory_id = e.target.value
                                    setDraft(p.id, (x) => ({
                                      ...x,
                                      allocationMatrix: {
                                        ...x.allocationMatrix,
                                        [row.key]: {
                                          factory_id,
                                          allocation_pct:
                                            x.allocationMatrix[row.key]?.allocation_pct ?? pct,
                                        },
                                      },
                                    }))
                                  }}
                                >
                                  {factories.map((f) => (
                                    <option key={f.id} value={f.id}>
                                      {f.name}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  step={5}
                                  value={pct}
                                  onChange={(e) => {
                                    const allocation_pct = parseInt(e.target.value, 10)
                                    setDraft(p.id, (x) => ({
                                      ...x,
                                      allocationMatrix: {
                                        ...x.allocationMatrix,
                                        [row.key]: {
                                          factory_id:
                                            x.allocationMatrix[row.key]?.factory_id ??
                                            selectedFactory,
                                          allocation_pct,
                                        },
                                      },
                                    }))
                                  }}
                                />
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  className="border border-slate-300 rounded px-2 py-1 text-center"
                                  value={pct}
                                  onChange={(e) => {
                                    const allocation_pct = Math.max(
                                      0,
                                      Math.min(100, parseInt(e.target.value, 10) || 0),
                                    )
                                    setDraft(p.id, (x) => ({
                                      ...x,
                                      allocationMatrix: {
                                        ...x.allocationMatrix,
                                        [row.key]: {
                                          factory_id:
                                            x.allocationMatrix[row.key]?.factory_id ??
                                            selectedFactory,
                                          allocation_pct,
                                        },
                                      },
                                    }))
                                  }}
                                />
                                <button
                                  type="button"
                                  className="text-xs text-slate-400 hover:text-rose-600"
                                  onClick={() =>
                                    setDraft(p.id, (x) => {
                                      const next = { ...x.allocationMatrix }
                                      delete next[row.key]
                                      return { ...x, allocationMatrix: next }
                                    })
                                  }
                                >
                                  clear
                                </button>
                              </div>
                            )
                          })}
                        </>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600"
                      onClick={() => handleSave(p)}
                      disabled={!dirty}
                    >
                      <Save className="w-4 h-4" />
                      Save product changes
                    </button>
                    {!dirty && <span className="text-xs text-slate-400">No unsaved changes.</span>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

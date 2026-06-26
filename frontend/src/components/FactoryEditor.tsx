import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react'
import type { Factory } from '../types'
import * as api from '../api'

interface Props {
  scenarioId: string
}

interface BayCell {
  year: number
  quarter: number
  bays: number
}

function bcKey(year: number, quarter: number) {
  return `${year}-Q${quarter}`
}

interface FactoryForm {
  name: string
  bays: number
  changeoverDays: number
  matrix: Record<string, BayCell>
}

function emptyForm(): FactoryForm {
  return { name: '', bays: 10, changeoverDays: 0, matrix: {} }
}

function formFromFactory(f: Factory): FactoryForm {
  const matrix: Record<string, BayCell> = {}
  for (const bc of f.bay_counts ?? []) {
    matrix[bcKey(bc.year, bc.quarter)] = { year: bc.year, quarter: bc.quarter, bays: bc.bays }
  }
  return { name: f.name, bays: f.bays, changeoverDays: f.changeover_days ?? 0, matrix }
}

/** Short human summary of a factory's per-quarter overrides, for the table. */
function overrideSummary(f: Factory): string {
  const bcs = f.bay_counts ?? []
  if (bcs.length === 0) return '—'
  return bcs
    .slice()
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter)
    .map((b) => `${b.year} Q${b.quarter}: ${b.bays}`)
    .join(', ')
}

export function FactoryEditor({ scenarioId }: Props) {
  const [factories, setFactories] = useState<Factory[]>([])
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FactoryForm>(emptyForm)
  /** id of the factory currently being edited (null = creating a new one). */
  const [editingId, setEditingId] = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const [yearRange, setYearRange] = useState<{ from: number; to: number }>(() => {
    const y = new Date().getFullYear()
    return { from: y, to: y + 1 }
  })

  async function reload() {
    try {
      setError(null)
      const list = await api.listFactories(scenarioId)
      setFactories(list)
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'load failed')
    }
  }
  useEffect(() => {
    if (scenarioId) void reload()
  }, [scenarioId])

  function startEdit(f: Factory) {
    setEditingId(f.id)
    setError(null)
    setForm(formFromFactory(f))
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    )
  }

  function cancelEdit() {
    setEditingId(null)
    setError(null)
    setForm(emptyForm())
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      setError('enter a factory name first')
      return
    }
    const bay_counts = Object.values(form.matrix).filter((c) => c.bays >= 0)
    try {
      if (editingId) {
        await api.updateFactory(editingId, form.name.trim(), form.bays, form.changeoverDays, bay_counts)
        setEditingId(null)
      } else {
        await api.createFactory(scenarioId, form.name.trim(), form.bays, form.changeoverDays, bay_counts)
      }
      setForm(emptyForm())
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

  const years: number[] = []
  for (let y = yearRange.from; y <= yearRange.to; y++) years.push(y)

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-rose-600">{error}</div>}

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Factory</th>
              <th className="text-left px-3 py-2 font-medium w-24">Base bays</th>
              <th className="text-left px-3 py-2 font-medium w-32">Changeover days</th>
              <th className="text-left px-3 py-2 font-medium">Per-quarter overrides</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {factories.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No factories yet.
                </td>
              </tr>
            )}
            {factories.map((f) => (
              <tr key={f.id} className={editingId === f.id ? 'bg-indigo-50' : undefined}>
                <td className="px-3 py-2 font-medium">{f.name}</td>
                <td className="px-3 py-2">{f.bays}</td>
                <td className="px-3 py-2">{f.changeover_days ?? 0}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{overrideSummary(f)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-2">
                    <button
                      className="text-indigo-500 hover:text-indigo-700"
                      onClick={() => startEdit(f)}
                      title="Edit"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      className="text-rose-500 hover:text-rose-700"
                      onClick={() => handleDelete(f.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* New / edit factory form */}
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
              <button
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
                onClick={cancelEdit}
              >
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
                placeholder="New factory name…"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSubmit()
                  }
                }}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Base bays</label>
              <input
                type="number"
                min={0}
                className="w-24 border border-slate-300 rounded px-2 py-1 text-sm text-center"
                value={form.bays}
                onChange={(e) => setForm((f) => ({ ...f, bays: parseInt(e.target.value) || 0 }))}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Changeover days</label>
              <input
                type="number"
                min={0}
                className="w-32 border border-slate-300 rounded px-2 py-1 text-sm text-center"
                value={form.changeoverDays}
                onChange={(e) =>
                  setForm((f) => ({ ...f, changeoverDays: parseInt(e.target.value) || 0 }))
                }
              />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-3 text-sm mb-2">
              <span className="text-xs text-slate-500">
                Per-quarter bay overrides (blank = use base value of{' '}
                <span className="font-medium">{form.bays}</span>). Matrix years:
              </span>
              <input
                type="number"
                className="w-20 border border-slate-300 rounded px-2 py-1 text-sm"
                value={yearRange.from}
                onChange={(e) =>
                  setYearRange((r) => ({ ...r, from: parseInt(e.target.value) || r.from }))
                }
              />
              <span className="text-slate-500">to</span>
              <input
                type="number"
                className="w-20 border border-slate-300 rounded px-2 py-1 text-sm"
                value={yearRange.to}
                onChange={(e) =>
                  setYearRange((r) => ({ ...r, to: parseInt(e.target.value) || r.to }))
                }
              />
            </div>
            <div className="overflow-x-auto">
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
                        const k = bcKey(y, q)
                        const cell = form.matrix[k]
                        return (
                          <td key={q} className="px-1 py-1">
                            <input
                              type="number"
                              min={0}
                              placeholder={`(${form.bays})`}
                              className="w-20 border border-slate-200 rounded px-2 py-1 text-center"
                              value={cell?.bays ?? ''}
                              onChange={(e) => {
                                const v = e.target.value.trim()
                                setForm((x) => {
                                  const next = { ...x, matrix: { ...x.matrix } }
                                  if (v === '') {
                                    delete next.matrix[k]
                                  } else {
                                    const n = parseInt(v)
                                    if (Number.isFinite(n) && n >= 0) {
                                      next.matrix[k] = { year: y, quarter: q, bays: n }
                                    }
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
          </div>

          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
              onClick={handleSubmit}
            >
              {editingId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {editingId ? 'Save changes' : 'Add factory'}
            </button>
            {editingId && (
              <button
                className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 bg-white text-slate-700 text-sm rounded hover:bg-slate-50"
                onClick={cancelEdit}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

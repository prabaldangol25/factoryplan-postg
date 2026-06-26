import { useState } from 'react'
import { Plus, Copy, Pencil, Trash2, Check } from 'lucide-react'
import type { Scenario } from '../types'
import * as api from '../api'

interface Props {
  scenarios: Scenario[]
  activeId: string | null
  onChange: (id: string | null) => void
  onReload: () => void | Promise<void>
}

export function ScenarioSwitcher({ scenarios, activeId, onChange, onReload }: Props) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(cloneFrom?: string) {
    if (!newName.trim()) return
    try {
      setError(null)
      const s = await api.createScenario(newName.trim(), cloneFrom)
      setNewName('')
      setCreating(false)
      await onReload()
      onChange(s.id)
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'create failed')
    }
  }

  async function handleRename(id: string) {
    if (!renameValue.trim()) return
    try {
      setError(null)
      await api.renameScenario(id, renameValue.trim())
      setRenamingId(null)
      setRenameValue('')
      await onReload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'rename failed')
    }
  }

  async function handleDelete(id: string) {
    const scenario = scenarios.find((s) => s.id === id)
    const typed = prompt(
      `Deleting scenario "${scenario?.name ?? id}" permanently removes its factories, products, demand, and runs. Type the scenario name to delete it.`,
    )
    if (typed !== scenario?.name) return
    try {
      setError(null)
      await api.deleteScenario(id)
      if (id === activeId) onChange(null)
      await onReload()
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'delete failed')
    }
  }

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium text-slate-700">Scenario:</span>
        <select
          className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
          value={activeId ?? ''}
          onChange={(e) => {
            const value = e.target.value
            if (value) onChange(value)
          }}
        >
          {scenarios.length === 0 && <option value="">(none yet)</option>}
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {activeId && (
          <>
            {renamingId === activeId ? (
              <>
                <input
                  className="border border-slate-300 rounded px-2 py-1 text-sm"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                />
                <button
                  className="text-emerald-600 hover:text-emerald-800"
                  onClick={() => handleRename(activeId)}
                  title="Save"
                >
                  <Check className="w-4 h-4" />
                </button>
              </>
            ) : (
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => {
                  const s = scenarios.find((s) => s.id === activeId)
                  setRenameValue(s?.name ?? '')
                  setRenamingId(activeId)
                }}
                title="Rename"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}

            <button
              className="text-slate-500 hover:text-slate-800"
              title="Clone"
              onClick={() => {
                const cloneFrom = activeId
                setNewName(
                  (scenarios.find((s) => s.id === activeId)?.name ?? 'scenario') + ' (copy)',
                )
                setCreating(true)
                ;(window as unknown as { __clone_from?: string }).__clone_from = cloneFrom
              }}
            >
              <Copy className="w-4 h-4" />
            </button>

            <button
              className="text-rose-500 hover:text-rose-700"
              title="Delete"
              onClick={() => handleDelete(activeId)}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {creating ? (
            <>
              <input
                className="border border-slate-300 rounded px-2 py-1 text-sm"
                placeholder="Scenario name…"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="px-3 py-1 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
                onClick={() => {
                  const cloneFrom = (window as unknown as { __clone_from?: string }).__clone_from
                  ;(window as unknown as { __clone_from?: string }).__clone_from = undefined
                  handleCreate(cloneFrom)
                }}
              >
                Create
              </button>
              <button
                className="px-2 py-1 text-sm text-slate-500 hover:text-slate-800"
                onClick={() => {
                  setCreating(false)
                  setNewName('')
                  ;(window as unknown as { __clone_from?: string }).__clone_from = undefined
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-4 h-4" />
              New scenario
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="max-w-6xl mx-auto px-6 pb-2 text-sm text-rose-600">{error}</div>
      )}
    </div>
  )
}

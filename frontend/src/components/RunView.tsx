import { useEffect, useState } from 'react'
import { Play, Loader2 } from 'lucide-react'
import type { Factory, Product, RunResult, ScenarioOrder } from '../types'
import * as api from '../api'

interface Props {
  scenarioId: string
  result: RunResult | null
  resultContext: { factories: Factory[]; products: Product[]; orders: ScenarioOrder[] } | null
  onResult: (
    r: RunResult,
    ctx: { factories: Factory[]; products: Product[]; orders: ScenarioOrder[] },
  ) => void
}

export function RunView({ scenarioId, result, onResult }: Props) {
  const [factories, setFactories] = useState<Factory[]>([])
  const [orders, setOrders] = useState<ScenarioOrder[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)


  async function loadContext() {
    try {
      setError(null)
      const [f, o] = await Promise.all([
        api.listFactories(scenarioId),
        api.listOrders(scenarioId),
      ])
      setFactories(f)
      setOrders(o)
      return { factories: f, products: [], orders: o }
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'failed to load scenario data')
      return null
    }
  }

  useEffect(() => {
    void loadContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId])

  async function handleRun() {
    setRunning(true)
    setError(null)
    try {
      const ctx = await loadContext()
      if (!ctx) return
      const r = await api.runScenario(scenarioId)
      onResult(r, ctx)
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'run failed')
    } finally {
      setRunning(false)
    }
  }

  const canRun = factories.length > 0 && orders.length > 0

  const totalDemandUnits = orders.length
  const totalBays = factories.reduce((s, f) => s + Math.max(f.bays, ...f.bay_weeks.map((w) => w.bays)), 0)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-base font-semibold mb-3">Scenario summary</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-slate-500">Factories</div>
            <div className="text-xl font-semibold">{factories.length}</div>
          </div>
          <div>
            <div className="text-slate-500">Total bays</div>
            <div className="text-xl font-semibold">{totalBays}</div>
          </div>
          <div>
            <div className="text-slate-500">Customers</div>
            <div className="text-xl font-semibold">{new Set(orders.map((o) => o.customer)).size}</div>
          </div>
          <div>
            <div className="text-slate-500">UTID orders</div>
            <div className="text-xl font-semibold">{totalDemandUnits}</div>
          </div>
        </div>
        {!canRun && (
          <div className="mt-4 text-sm text-amber-700">
            Add at least one factory with weekly bays and at least one UTID order before running.
          </div>
        )}

        <div className="mt-4 text-sm text-slate-500">
          Scheduler assigns each UTID to the factory/bay that can finish it earliest, starting from the first capacity week.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRun}
            disabled={!canRun || running}
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run scheduler
              </>
            )}
          </button>
          {result && (
            <span className="text-sm text-slate-500">
              Last run: {new Date(result.run.run_at).toLocaleString()}
            </span>
          )}
        </div>
        {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
      </div>
    </div>
  )
}

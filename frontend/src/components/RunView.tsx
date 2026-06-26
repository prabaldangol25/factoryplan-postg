import { useEffect, useState } from 'react'
import { Play, Loader2 } from 'lucide-react'
import type { Demand, Factory, Product, RunResult } from '../types'
import * as api from '../api'

interface Props {
  scenarioId: string
  result: RunResult | null
  resultContext: { factories: Factory[]; products: Product[]; demand: Demand[] } | null
  onResult: (
    r: RunResult,
    ctx: { factories: Factory[]; products: Product[]; demand: Demand[] },
  ) => void
}

export function RunView({ scenarioId, result, onResult }: Props) {
  const [factories, setFactories] = useState<Factory[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [demand, setDemand] = useState<Demand[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [optimize, setOptimize] = useState<api.OptimizeMode>('balance')

  async function loadContext() {
    try {
      setError(null)
      const [f, p, d] = await Promise.all([
        api.listFactories(scenarioId),
        api.listProducts(scenarioId),
        api.listDemand(scenarioId),
      ])
      setFactories(f)
      setProducts(p)
      setDemand(d)
      return { factories: f, products: p, demand: d }
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
      const r = await api.runScenario(scenarioId, optimize)
      onResult(r, ctx)
    } catch (e: unknown) {
      setError(((e as { message?: string }).message) ?? 'run failed')
    } finally {
      setRunning(false)
    }
  }

  const canRun = factories.length > 0 && products.length > 0 && demand.length > 0

  const totalDemandUnits = demand.reduce((s, d) => s + d.quantity, 0)
  const totalBays = factories.reduce((s, f) => s + f.bays, 0)

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
            <div className="text-slate-500">Products</div>
            <div className="text-xl font-semibold">{products.length}</div>
          </div>
          <div>
            <div className="text-slate-500">Demand units</div>
            <div className="text-xl font-semibold">{totalDemandUnits}</div>
          </div>
        </div>
        {!canRun && (
          <div className="mt-4 text-sm text-amber-700">
            Add at least one factory, product, and demand row before running.
          </div>
        )}

        <div className="mt-4">
          <div className="text-sm font-medium text-slate-600 mb-1.5">Bay assignment</div>
          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="optimize"
                className="mt-0.5"
                checked={optimize === 'balance'}
                onChange={() => setOptimize('balance')}
              />
              <span>
                <span className="font-medium text-slate-700">Balance load</span>
                <span className="text-slate-500">
                  {' '}
                  — spread work across all factories and bays.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="optimize"
                className="mt-0.5"
                checked={optimize === 'utilization'}
                onChange={() => setOptimize('utilization')}
              />
              <span>
                <span className="font-medium text-slate-700">Maximize utilization</span>
                <span className="text-slate-500">
                  {' '}
                  — pack work into as few bays as possible; unneeded bays stay empty
                  (shown green in the Gantt).
                </span>
              </span>
            </label>
          </div>
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

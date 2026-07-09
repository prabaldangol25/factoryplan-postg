import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Factory as FactoryIcon,
  Building2,
  BarChart3,
  Download,
  Table2,
} from 'lucide-react'
import * as api from './api'
import type { Factory, Product, RunResult, Scenario, ScenarioOrder } from './types'
import { ScenarioSwitcher } from './components/ScenarioSwitcher'
import { FactoryEditor } from './components/FactoryEditor'
const GanttView = lazy(() =>
  import('./components/GanttView').then((m) => ({ default: m.GanttView })),
)
import { ReportView } from './components/ReportView'
import './App.css'

type Tab =
  | 'factories'
  | 'results'
  | 'report'

const ACTIVE_SCENARIO_KEY = 'factoryplan.activeScenarioId'

function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_SCENARIO_KEY) || null,
  )
  const [tab, setTab] = useState<Tab>('factories')
  const [bootError, setBootError] = useState<string | null>(null)

  // Lifted state so results survive tab switches
  const [result, setResult] = useState<RunResult | null>(null)
  const [resultContext, setResultContext] = useState<{
    factories: Factory[]
    products: Product[]
    orders: ScenarioOrder[]
  } | null>(null)

  async function reloadScenarios() {
    try {
      const list = await api.listScenarios()
      setScenarios(list)
      const activeExists = activeId ? list.some((s) => s.id === activeId) : false
      if (list.length === 0) {
        setActiveId(null)
      } else if (!activeId || !activeExists) {
        setActiveId(list[0].id)
      }
    } catch (e: unknown) {
      setBootError(((e as { message?: string }).message) ?? 'failed to load scenarios')
    }
  }

  useEffect(() => {
    void reloadScenarios()
  }, [])

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_SCENARIO_KEY, activeId)
    else localStorage.removeItem(ACTIVE_SCENARIO_KEY)
  }, [activeId])

  // Clear result whenever scenario changes
  useEffect(() => {
    setResult(null)
    setResultContext(null)
  }, [activeId])

  if (bootError) {
    return (
      <div className="min-h-full flex items-center justify-center p-6">
        <div className="max-w-md text-center text-rose-700">
          <div className="font-semibold mb-2">Backend not reachable</div>
          <div className="text-sm">{bootError}</div>
          <div className="text-sm mt-3 text-slate-500">
            Run <code className="bg-slate-100 px-1.5 py-0.5 rounded">cargo run</code> in the
            backend/ directory.
          </div>
        </div>
      </div>
    )
  }

  const tabs: Array<{ key: Tab; label: string; icon: typeof FactoryIcon }> = [
    { key: 'factories', label: 'Plan', icon: Building2 },
    { key: 'results', label: 'Results', icon: BarChart3 },
    { key: 'report', label: 'Report', icon: Table2 },
  ]

  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3">
          <FactoryIcon className="w-6 h-6 text-indigo-600" />
          <h1 className="text-lg font-semibold">factoryplanMS</h1>
        </div>
      </header>

      <ScenarioSwitcher
        scenarios={scenarios}
        activeId={activeId}
        onChange={setActiveId}
        onReload={reloadScenarios}
      />

      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 flex gap-1">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={
                  'flex items-center gap-2 px-3 py-2 text-sm border-b-2 ' +
                  (active
                    ? 'border-indigo-600 text-indigo-700 font-medium'
                    : 'border-transparent text-slate-600 hover:text-slate-900')
                }
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            )
          })}
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {activeId == null ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
            Create a scenario to get started.
          </div>
        ) : (
          <>
            {tab === 'factories' && (
              <FactoryEditor
                scenarioId={activeId}
                onResult={(r, ctx) => {
                  setResult(r)
                  setResultContext(ctx)
                  setTab('results')
                }}
              />
            )}
            {tab === 'results' && (
              <ResultsTab result={result} context={resultContext} onGoToRun={() => setTab('factories')} />
            )}
            {tab === 'report' && (
              <ReportView
                result={result}
                context={resultContext}
                onGoToRun={() => setTab('factories')}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

interface ResultsTabProps {
  result: RunResult | null
  context: { factories: Factory[]; products: Product[]; orders: ScenarioOrder[] } | null
  onGoToRun: () => void
}

function ResultsTab({ result, context, onGoToRun }: ResultsTabProps) {
  if (!result || !context) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500 text-sm">
        No results yet.{' '}
        <button className="text-indigo-600 hover:underline" onClick={onGoToRun}>
          Go to the Plan tab
        </button>{' '}
        to compute a schedule.
      </div>
    )
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <a
          href={api.exportRunCsvUrl(result.run.id)}
          className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 bg-white text-slate-700 text-sm rounded hover:bg-slate-50"
        >
          <Download className="w-4 h-4" />
          CSV
        </a>
        <a
          href={api.exportRunXlsxUrl(result.run.id)}
          className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 bg-white text-slate-700 text-sm rounded hover:bg-slate-50"
        >
          <Download className="w-4 h-4" />
          XLSX
        </a>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-slate-500">UTID orders</div>
          <div className="text-xl font-semibold">{result.run.total_demand}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-slate-500">Scheduled</div>
          <div className="text-xl font-semibold">{result.run.shipped_on_time}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-slate-500">Unscheduled</div>
          <div className="text-xl font-semibold">{result.run.unshippable}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-slate-500">Factories</div>
          <div className="text-xl font-semibold">{context.factories.length}</div>
        </div>
      </div>
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Gantt by factory</h3>
        <Suspense
          fallback={
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
              Loading chart…
            </div>
          }
        >
          <GanttView result={result} factories={context.factories} products={context.products} />
        </Suspense>
      </section>
    </div>
  )
}

export default App

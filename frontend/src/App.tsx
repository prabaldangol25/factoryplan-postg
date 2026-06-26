import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Factory as FactoryIcon,
  Building2,
  Package,
  ListChecks,
  Play,
  BarChart3,
  Download,
  MessageCircle,
  Table2,
  LayoutGrid,
  Users,
} from 'lucide-react'
import * as api from './api'
import type { Demand, Factory, Product, RunResult, Scenario } from './types'
import { ScenarioSwitcher } from './components/ScenarioSwitcher'
import { FactoryEditor } from './components/FactoryEditor'
import { ProductEditor } from './components/ProductEditor'
import { DemandEditor } from './components/DemandEditor'
import { RunView } from './components/RunView'
const GanttView = lazy(() =>
  import('./components/GanttView').then((m) => ({ default: m.GanttView })),
)
import { ShipmentSummary } from './components/ShipmentSummary'
import { RecommendationPanel } from './components/RecommendationPanel'
import { UnshippableList } from './components/UnshippableList'
import { BacklogView } from './components/BacklogView'
import { ReportView } from './components/ReportView'
const BayRequirementsView = lazy(() =>
  import('./components/BayRequirementsView').then((m) => ({ default: m.BayRequirementsView })),
)
const HeadcountView = lazy(() =>
  import('./components/HeadcountView').then((m) => ({ default: m.HeadcountView })),
)
const AgentChat = lazy(() =>
  import('./components/AgentChat').then((m) => ({ default: m.AgentChat })),
)
import './App.css'

type Tab =
  | 'factories'
  | 'products'
  | 'demand'
  | 'run'
  | 'results'
  | 'bays'
  | 'headcount'
  | 'report'
  | 'agent'

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
    demand: Demand[]
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
    { key: 'factories', label: 'Factories', icon: Building2 },
    { key: 'products', label: 'Products', icon: Package },
    { key: 'demand', label: 'Demand', icon: ListChecks },
    { key: 'run', label: 'Run', icon: Play },
    { key: 'results', label: 'Results', icon: BarChart3 },
    { key: 'bays', label: 'Bay Req', icon: LayoutGrid },
    { key: 'headcount', label: 'Headcount', icon: Users },
    { key: 'report', label: 'Report', icon: Table2 },
    { key: 'agent', label: 'Agent', icon: MessageCircle },
  ]

  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3">
          <FactoryIcon className="w-6 h-6 text-indigo-600" />
          <h1 className="text-lg font-semibold">factoryplan-rust</h1>
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
            {tab === 'factories' && <FactoryEditor scenarioId={activeId} />}
            {tab === 'products' && <ProductEditor scenarioId={activeId} />}
            {tab === 'demand' && <DemandEditor scenarioId={activeId} />}
            {tab === 'run' && (
              <RunView
                scenarioId={activeId}
                result={result}
                resultContext={resultContext}
                onResult={(r, ctx) => {
                  setResult(r)
                  setResultContext(ctx)
                  setTab('results')
                }}
              />
            )}
            {tab === 'results' && (
              <ResultsTab result={result} context={resultContext} onGoToRun={() => setTab('run')} />
            )}
            {tab === 'bays' && (
              <Suspense
                fallback={<div className="p-6 text-slate-500 text-sm">Loading…</div>}
              >
                <BayRequirementsView scenarioId={activeId} />
              </Suspense>
            )}
            {tab === 'headcount' && (
              <Suspense
                fallback={<div className="p-6 text-slate-500 text-sm">Loading…</div>}
              >
                <HeadcountView
                  scenarioId={activeId}
                  result={result}
                  context={resultContext}
                  onGoToRun={() => setTab('run')}
                />
              </Suspense>
            )}
            {tab === 'report' && (
              <ReportView
                result={result}
                context={resultContext}
                onGoToRun={() => setTab('run')}
              />
            )}
            {tab === 'agent' && (
              <Suspense
                fallback={<div className="p-6 text-slate-500 text-sm">Loading agent…</div>}
              >
                <AgentChat scenarioId={activeId} />
              </Suspense>
            )}
          </>
        )}
      </main>
    </div>
  )
}

interface ResultsTabProps {
  result: RunResult | null
  context: { factories: Factory[]; products: Product[]; demand: Demand[] } | null
  onGoToRun: () => void
}

function ResultsTab({ result, context, onGoToRun }: ResultsTabProps) {
  if (!result || !context) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500 text-sm">
        No results yet.{' '}
        <button className="text-indigo-600 hover:underline" onClick={onGoToRun}>
          Go to the Run tab
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
      <RecommendationPanel
        recommendation={result.recommendation}
        totalDemand={result.run.total_demand}
        shipped={result.run.shipped_on_time}
        shippedLate={result.run.shipped_late}
        unshippable={result.run.unshippable}
      />
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Quarterly backlog</h3>
        <BacklogView result={result} />
      </section>
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Shipment summary</h3>
        <ShipmentSummary
          result={result}
          demand={context.demand}
          products={context.products}
          factories={context.factories}
        />
      </section>
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Gantt by factory</h3>
        <Suspense
          fallback={
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
              Loading chart…
            </div>
          }
        >
          <GanttView
            result={result}
            factories={context.factories}
            products={context.products}
          />
        </Suspense>
      </section>
      {result.run.unshippable > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Unshippable units</h3>
          <UnshippableList result={result} products={context.products} />
        </section>
      )}
    </div>
  )
}

export default App

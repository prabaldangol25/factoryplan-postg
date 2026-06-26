import axios from 'axios'
import type {
  Scenario,
  Factory,
  Product,
  Demand,
  PeriodType,
  SpreadMode,
  SerialMode,
  RunResult,
  AgentConversation,
  AgentMessage,
} from '../types'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`

const client = axios.create({
  baseURL: apiBaseUrl || '/',
  headers: { 'Content-Type': 'application/json' },
})

export interface ApiError {
  status: number
  message: string
}

function rethrow(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0
    const msg =
      (err.response?.data as { error?: string } | undefined)?.error ??
      err.message ??
      'unknown error'
    const e: ApiError = { status, message: msg }
    throw e
  }
  throw err
}

// ---------- health ----------
export async function getHealth(): Promise<{ status: string; service: string; version: string }> {
  return client
    .get('/api/health')
    .then((r) => r.data)
    .catch(rethrow)
}

// ---------- scenarios ----------
export async function listScenarios(): Promise<Scenario[]> {
  return client.get('/api/scenarios').then((r) => r.data).catch(rethrow)
}

export async function createScenario(name: string, clone_from?: string): Promise<Scenario> {
  return client
    .post('/api/scenarios', { name, clone_from })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function renameScenario(id: string, name: string): Promise<Scenario> {
  return client.put(`/api/scenarios/${id}`, { name }).then((r) => r.data).catch(rethrow)
}

export async function deleteScenario(id: string): Promise<void> {
  return client.delete(`/api/scenarios/${id}`).then(() => undefined).catch(rethrow)
}

export async function activateScenario(id: string): Promise<void> {
  return client.post(`/api/scenarios/${id}/activate`).then(() => undefined).catch(rethrow)
}

// ---------- factories ----------
export async function listFactories(scenarioId: string): Promise<Factory[]> {
  return client.get(`/api/scenarios/${scenarioId}/factories`).then((r) => r.data).catch(rethrow)
}

export interface BayCountInput {
  year: number
  quarter: number
  bays: number
}

export async function createFactory(
  scenarioId: string,
  name: string,
  bays: number,
  changeover_days: number,
  bay_counts: BayCountInput[] = [],
): Promise<Factory> {
  return client
    .post(`/api/scenarios/${scenarioId}/factories`, { name, bays, changeover_days, bay_counts })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function updateFactory(
  id: string,
  name: string,
  bays: number,
  changeover_days: number,
  bay_counts: BayCountInput[] = [],
): Promise<Factory> {
  return client
    .put(`/api/factories/${id}`, { name, bays, changeover_days, bay_counts })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function deleteFactory(id: string): Promise<void> {
  return client.delete(`/api/factories/${id}`).then(() => undefined).catch(rethrow)
}

// ---------- products ----------
export interface LeadTimeInput {
  year: number
  quarter: number
  lead_time_days: number
}

export interface FactoryLeadTimeInput {
  factory_id: string
  year: number
  quarter: number
  lead_time_days: number
}

export interface FactoryAllocationInput {
  factory_id: string
  year: number
  quarter: number
  allocation_pct: number
}

export async function listProducts(scenarioId: string): Promise<Product[]> {
  return client.get(`/api/scenarios/${scenarioId}/products`).then((r) => r.data).catch(rethrow)
}

export async function createProduct(
  scenarioId: string,
  name: string,
  lead_times: LeadTimeInput[],
  factory_lead_times: FactoryLeadTimeInput[] = [],
  factory_allocations: FactoryAllocationInput[] = [],
): Promise<Product> {
  return client
    .post(`/api/scenarios/${scenarioId}/products`, {
      name,
      lead_times,
      factory_lead_times,
      factory_allocations,
    })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function updateProduct(
  id: string,
  name: string,
  lead_times: LeadTimeInput[],
  factory_lead_times: FactoryLeadTimeInput[] = [],
  factory_allocations: FactoryAllocationInput[] = [],
): Promise<Product> {
  return client
    .put(`/api/products/${id}`, { name, lead_times, factory_lead_times, factory_allocations })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function deleteProduct(id: string): Promise<void> {
  return client.delete(`/api/products/${id}`).then(() => undefined).catch(rethrow)
}

// ---------- demand ----------
export interface DemandInput {
  product_id: string
  period_type: PeriodType
  year: number
  period_index: number
  quantity: number
  spread_mode: SpreadMode
  serial_mode?: SerialMode
  serial_start?: string | null
  serial_list?: string | null
}

export async function listDemand(scenarioId: string): Promise<Demand[]> {
  return client.get(`/api/scenarios/${scenarioId}/demand`).then((r) => r.data).catch(rethrow)
}

export async function createDemand(scenarioId: string, d: DemandInput): Promise<Demand> {
  return client
    .post(`/api/scenarios/${scenarioId}/demand`, d)
    .then((r) => r.data)
    .catch(rethrow)
}

export async function updateDemand(id: string, d: DemandInput): Promise<Demand> {
  return client.put(`/api/demand/${id}`, d).then((r) => r.data).catch(rethrow)
}

export async function deleteDemand(id: string): Promise<void> {
  return client.delete(`/api/demand/${id}`).then(() => undefined).catch(rethrow)
}

// ---------- run (Phase 2) ----------
export type OptimizeMode = 'balance' | 'utilization'

export async function runScenario(
  scenarioId: string,
  optimize: OptimizeMode = 'balance',
): Promise<RunResult> {
  const params = optimize === 'utilization' ? { optimize: 'utilization' } : {}
  return client
    .post(`/api/scenarios/${scenarioId}/run`, null, { params })
    .then((r) => r.data)
    .catch(rethrow)
}

// ---------- import / export (Phase 5) ----------
export interface ImportResult {
  inserted: number
  skipped: number
  errors: string[]
}

export async function importDemandExcel(
  scenarioId: string,
  file: File,
): Promise<ImportResult> {
  const form = new FormData()
  form.append('file', file)
  return axios
    .post(apiUrl(`/api/scenarios/${scenarioId}/demand/import-excel`), form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data)
    .catch(rethrow)
}

export function exportRunCsvUrl(runId: string): string {
  return apiUrl(`/api/runs/${runId}/export.csv`)
}

export function exportRunXlsxUrl(runId: string): string {
  return apiUrl(`/api/runs/${runId}/export.xlsx`)
}

// ---------- agent (Devin-powered scheduling chat) ----------
export async function listConversations(scenarioId: string): Promise<AgentConversation[]> {
  return client
    .get('/api/agent/conversations', { params: { scenario_id: scenarioId } })
    .then((r) => r.data)
    .catch(rethrow)
}

export async function getConversationMessages(convId: string): Promise<AgentMessage[]> {
  return client
    .get(`/api/agent/conversations/${convId}/messages`)
    .then((r) => r.data)
    .catch(rethrow)
}

export async function deleteConversation(convId: string): Promise<void> {
  return client
    .delete(`/api/agent/conversations/${convId}`)
    .then(() => undefined)
    .catch(rethrow)
}

/**
 * Stream a chat turn over SSE. Uses fetch + ReadableStream (axios can't stream).
 * Calls `onChunk` for each response line, `onConversation` once with the
 * conversation id, `onError` on a fatal error, and `onDone` when complete.
 * Returns an AbortController so callers can cancel an in-flight turn.
 */
export function sendAgentMessage(
  params: {
    scenarioId: string
    message: string
    conversationId: string | null
  },
  handlers: {
    onConversation?: (id: string) => void
    onChunk: (line: string) => void
    onError: (message: string) => void
    onDone: () => void
  },
): AbortController {
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(apiUrl('/api/agent/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: params.scenarioId,
          message: params.message,
          conversation_id: params.conversationId,
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        handlers.onError(`HTTP ${res.status}`)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // SSE events are separated by a blank line; each event has `data: ` lines.
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          // An SSE event may have multiple `data:` lines; join them with \n.
          const dataLines = rawEvent
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(l.startsWith('data: ') ? 6 : 5))
          if (dataLines.length === 0) continue
          const data = dataLines.join('\n')

          if (data.startsWith('[CONV] ')) {
            handlers.onConversation?.(data.slice(7).trim())
          } else if (data === '[DONE]') {
            handlers.onDone()
            return
          } else if (data.startsWith('[ERROR]')) {
            handlers.onError(data.slice(7).trim())
            return
          } else {
            handlers.onChunk(data)
          }
        }
      }
      handlers.onDone()
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'AbortError') return
      handlers.onError((e as { message?: string }).message ?? 'stream failed')
    }
  })()

  return controller
}

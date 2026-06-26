# Devin-Powered Scheduling Agent — Implementation Plan

## 1. Overview

Add a **chat-based AI scheduling expert** to factoryplan-rust, powered by the
`devin` CLI binary (`devin -p --dangerously-skip-permissions`). The agent lives
in a new "Agent" tab and has full read/write access to every API endpoint. It
understands finite-capacity scheduling, cycle times, bay constraints, lead times,
demand planning, and can run what-if experiments by calling the factoryplan API.

### Architecture

```
Browser (Agent Chat UI)
    │
    │  POST /api/agent/chat  { scenario_id, message, conversation_id? }
    │  ←── SSE stream of markdown chunks
    │
    ▼
Actix Backend (handlers/agent.rs)
    │
    │  1. Build system prompt (domain expertise + API ref + scenario snapshot)
    │  2. Spawn:  devin -p --dangerously-skip-permissions
    │  3. Feed prompt + user message via stdin/temp-file
    │  4. Stream devin's stdout back to client via SSE
    │  5. After completion, extract final response, persist to DB
    │
    │  Devin can call:
    ▼
factoryplan REST API (localhost:8080)
    via curl from within the devin subprocess
```

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| LLM engine | `devin -p` CLI | User preference; no API keys; strong tool-use |
| Runtime | Backend (Rust) | Single deploy; no sidecar process for user to manage |
| Data access | REST API (curl) | Devin calls the same endpoints the UI uses |
| UX | Chat panel with SSE streaming | Responsive feel despite 10-30s latency |
| Output parsing | Temp-file approach with delimiter fallback | Cleanest separation of tool output vs response |
| Context management | 3-tier (stats → summary → API self-serve) | Keeps prompt small; devin digs deeper via API |
| Persistence | SQLite tables for conversations + messages | Survives restart; per-scenario history |

---

## 2. Risk mitigations (built into the design)

### Risk 1: Slow responses (10-30s per message)

**Mitigation: SSE streaming + optimistic UI**

- `POST /api/agent/chat` returns `Content-Type: text/event-stream`
- Backend pipes devin's stdout line-by-line as `data: <line>\n\n` SSE events
- Frontend shows the user's message immediately + a typing indicator
- On subsequent messages in the same conversation, skip the full scenario
  snapshot (devin already has context) — reduces prompt size and latency
- Hard timeout: 120 seconds. On timeout, kill the devin process and send a
  `data: [ERROR] Agent timed out\n\n` event, then close the stream
- Final event: `data: [DONE]\n\n` signals stream end

### Risk 2: Devin output parsing (tool output mixed with response)

**Mitigation: Temp-file for response**

The system prompt instructs devin:

> Write your final response (and ONLY the final response) to the file
> `/tmp/factoryplan_agent_response_{conversation_id}.md`. Do not print your
> response to stdout. You may print progress notes to stdout while working.

After devin exits (or after the stream closes), the backend reads the temp file
and persists it as the assistant message. If the temp file is missing or empty,
fall back to capturing devin's last N lines of stdout as the response.

**Fallback: delimiter parsing**

If the temp-file approach proves unreliable, alternative instruction:

> Wrap your final answer between `---AGENT_RESPONSE_START---` and
> `---AGENT_RESPONSE_END---` markers. Everything between these markers is
> your response. Everything outside is internal work.

Backend regex-extracts between markers.

### Risk 3: Prompt size / context limits

**Mitigation: 3-tier context injection**

The system prompt has three sections with different verbosity:

**Tier 1 — Always included (~500 tokens)**
```
Active scenario: "Baseline 2026"
  Factories: 3 (total 25 bays)
  Products: 2
  Demand: 8 rows, 150 units total
  Last run: 150 total, 132 shipped, 18 unshippable (88% fill)
  Recommendations: add 3 bays at Factory A, or reduce LTs by 15.2%
```

**Tier 2 — Included on first message in conversation (~2K tokens)**
```
Factories:
  Factory A: 10 bays (base), Q3 2026: 8 bays, Q4 2026: 12 bays
  Factory B: 8 bays (base)
  Factory C: 7 bays (base)

Products:
  Widget: LT range 20-30 days (Q1 2026: 30d, Q2: 28d, Q3: 25d, Q4: 20d)
  Gadget: LT range 15-20 days (Q1 2026: 20d, Q2: 18d, Q3: 15d, Q4: 15d)

Demand summary (by period):
  2026 Q3: Widget 80 units, Gadget 30 units
  2026 Q4: Widget 25 units, Gadget 15 units
```

**Tier 3 — On demand (devin calls API)**

System prompt tells devin:

> For detailed per-unit data, individual bay assignments, per-quarter bay
> matrices, or exact lead-time values, call the API using curl. Here are
> the endpoints: [full API reference]

---

## 3. Database migration

**File: `backend/migrations/0003_agent.sql`**

```sql
CREATE TABLE agent_conversation (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    title       TEXT,           -- auto-generated from first user message
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_agent_conv_scenario ON agent_conversation(scenario_id);

CREATE TABLE agent_message (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_agent_msg_conv ON agent_message(conversation_id);
```

---

## 4. Backend models

**Add to `backend/src/models.rs`:**

```rust
// ---------- Agent ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AgentConversation {
    pub id: String,
    pub scenario_id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AgentMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,           // 'user' | 'assistant' | 'system'
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AgentChatRequest {
    pub scenario_id: String,
    pub message: String,
    pub conversation_id: Option<String>,  // None = new conversation
}
```

---

## 5. Backend handler: `handlers/agent.rs`

### Endpoint: `POST /api/agent/chat`

**Input:**
```json
{
  "scenario_id": "uuid",
  "message": "Why can't Q3 demand ship on time?",
  "conversation_id": "uuid or null"
}
```

**Output:** SSE stream

```
data: Looking at the Q3 demand for your scenario...
data:
data: The issue is that Factory A only has 8 bays in Q3 (down from 10 baseline),
data: while you have 80 Widget units with a 25-day lead time each.
data:
data: [DONE]
```

### Handler logic (pseudocode)

```rust
#[post("/api/agent/chat")]
async fn agent_chat(
    pool: web::Data<Pool>,
    body: web::Json<AgentChatRequest>,
) -> AppResult<HttpResponse> {
    let scenario_id = &body.scenario_id;
    let user_msg = &body.message;

    // 1. Get or create conversation
    let conv_id = match &body.conversation_id {
        Some(id) => {
            // Verify exists
            id.clone()
        }
        None => {
            // Create new conversation
            let id = new_id();
            // INSERT INTO agent_conversation ...
            id
        }
    };

    // 2. Persist user message
    // INSERT INTO agent_message (role='user', content=user_msg) ...

    // 3. Load conversation history (for multi-turn context)
    let history: Vec<AgentMessage> = /* SELECT ... WHERE conversation_id ORDER BY created_at */;

    // 4. Build system prompt
    let system_prompt = build_system_prompt(pool, scenario_id, &history).await?;

    // 5. Build devin input (system prompt + conversation history + new message)
    let devin_input = format_devin_input(&system_prompt, &history, user_msg);

    // 6. Write input to temp file
    let input_path = format!("/tmp/factoryplan_agent_input_{conv_id}.txt");
    std::fs::write(&input_path, &devin_input)?;

    // 7. Spawn devin process
    let response_path = format!("/tmp/factoryplan_agent_response_{conv_id}.md");
    let child = tokio::process::Command::new("devin")
        .args([
            "-p",
            "--dangerously-skip-permissions",
            &format!("Read the instructions from {input_path}. \
                       Write your response to {response_path}. \
                       The factoryplan API is at http://127.0.0.1:8080."),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    // 8. Stream stdout via SSE
    let stream = stream_devin_output(child, &response_path, &conv_id, pool).await;

    Ok(HttpResponse::Ok()
        .content_type("text/event-stream")
        .streaming(stream))
}
```

### System prompt builder

```rust
async fn build_system_prompt(
    pool: &Pool,
    scenario_id: &str,
    history: &[AgentMessage],
) -> AppResult<String> {
    let is_first_message = history.is_empty();

    // Always: Tier 1 stats
    let stats = load_scenario_stats(pool, scenario_id).await?;

    // First message: Tier 2 details
    let details = if is_first_message {
        Some(load_scenario_details(pool, scenario_id).await?)
    } else {
        None
    };

    let mut prompt = String::new();

    // Domain expertise
    prompt.push_str(DOMAIN_EXPERTISE);

    // API reference
    prompt.push_str(API_REFERENCE);

    // Scenario context
    prompt.push_str(&format_scenario_context(&stats, details.as_deref()));

    // Instructions
    prompt.push_str(RESPONSE_INSTRUCTIONS);

    Ok(prompt)
}
```

### Key constants

```rust
const DOMAIN_EXPERTISE: &str = r#"
You are a finite-capacity scheduling expert. You deeply understand:

- **Cycle time (CT)**: Days a unit occupies a bay from build start to ship.
  In this app, called "lead time" — it is per (product, quarter).
- **Bays**: Physical build positions in a factory. A bay can hold one unit
  at a time. Bay count can vary per quarter (seasonal ramp-up/down).
- **Backward scheduling**: Units are scheduled backward from their due date.
  Required window = [due_date - lead_time + 1, due_date]. The scheduler places
  units by earliest required_start first, picking the least-loaded free bay
  across all factories (global greedy, load-balanced).
- **Demand explosion**: Aggregate demand (e.g. "20 units in Q3") is exploded
  into individual units with due dates spread evenly across the period (or
  clustered at start/end depending on spread_mode).
- **Capacity constraint**: If no bay is free for a unit's required window,
  that unit is marked "unshippable".
- **Cross-quarter windows**: When a build window spans two quarters, the
  effective bay count is the MINIMUM of the two quarters (conservative —
  a build can't use bays that don't exist in one of the quarters).

When analyzing scenarios, think in manufacturing terms. Reference specific
factories, products, quarters, bay counts, and lead times. Be quantitative —
cite numbers, percentages, and specific dates.
"#;

const API_REFERENCE: &str = r#"
## factoryplan API Reference (http://127.0.0.1:8080)

You can call any endpoint using curl. All responses are JSON.

### Read endpoints
GET  /api/scenarios                           — List all scenarios
GET  /api/scenarios/{id}                      — Get scenario details
GET  /api/scenarios/{id}/factories            — List factories (includes bay_counts per quarter)
GET  /api/scenarios/{id}/products             — List products (includes lead_times per quarter)
GET  /api/scenarios/{id}/demand               — List demand rows
GET  /api/runs/{id}                           — Get a specific run's results + recommendations

### Write endpoints
POST /api/scenarios                           — Create scenario { name, clone_from? }
POST /api/scenarios/{id}/factories            — Create factory { name, bays, bay_counts[] }
PUT  /api/factories/{id}                      — Update factory { name, bays, bay_counts[] }
POST /api/scenarios/{id}/products             — Create product { name, lead_times[] }
PUT  /api/products/{id}                       — Update product { name, lead_times[] }
POST /api/scenarios/{id}/demand               — Create demand row
POST /api/scenarios/{id}/run                  — Execute scheduler (returns full results)

### Example: run scheduler and get results
curl -s -X POST http://127.0.0.1:8080/api/scenarios/{SCENARIO_ID}/run

Response includes:
  run: { total_demand, shipped_on_time, unshippable }
  units: [ { product_id, factory_id, bay_index, required_start, due_date, status } ]
  recommendation: { bays_needed, uniform_lt_pct, per_product_lt[] }
"#;

const RESPONSE_INSTRUCTIONS: &str = r#"
## Instructions

1. Answer the user's question about the scheduling scenario.
2. If you need more data, call the API using curl (silently — don't dump raw JSON).
3. To test what-if scenarios, clone the scenario, modify it, run it, compare results.
4. Be specific: cite factory names, product names, quantities, dates, percentages.
5. Use markdown formatting: headers, bullet points, tables, bold for emphasis.
6. Write your complete response to the specified output file.
7. If creating what-if scenarios, explain what you changed and why, then show results.
"#;
```

### Streaming helper

```rust
use actix_web::web::Bytes;
use futures_util::stream::Stream;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;

async fn stream_devin_output(
    mut child: Child,
    response_path: &str,
    conv_id: &str,
    pool: web::Data<Pool>,
) -> impl Stream<Item = Result<Bytes, actix_web::Error>> {
    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    // Use a channel to stream
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, actix_web::Error>>(64);
    let response_path = response_path.to_string();
    let conv_id = conv_id.to_string();
    let pool_clone = pool.clone();

    tokio::spawn(async move {
        let timeout = tokio::time::Duration::from_secs(120);
        let start = tokio::time::Instant::now();

        while let Ok(result) = tokio::time::timeout(
            timeout.saturating_sub(start.elapsed()),
            lines.next_line(),
        ).await {
            match result {
                Ok(Some(line)) => {
                    let event = format!("data: {}\n\n", line);
                    if tx.send(Ok(Bytes::from(event))).await.is_err() {
                        break; // client disconnected
                    }
                }
                Ok(None) => break, // EOF
                Err(e) => {
                    let _ = tx.send(Ok(Bytes::from(
                        format!("data: [ERROR] {}\n\n", e)
                    ))).await;
                    break;
                }
            }
        }

        // Wait for process to finish (with timeout)
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            child.wait(),
        ).await;

        // Read response from temp file
        let response = match tokio::fs::read_to_string(&response_path).await {
            Ok(content) if !content.trim().is_empty() => content,
            _ => "(Agent did not produce a response)".to_string(),
        };

        // Persist assistant message
        let _ = persist_assistant_message(&pool_clone, &conv_id, &response).await;

        // Clean up temp files
        let _ = tokio::fs::remove_file(&response_path).await;

        // Send done event
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
    });

    tokio_stream::wrappers::ReceiverStream::new(rx)
}
```

### Other endpoints

```rust
/// List conversations for a scenario
#[get("/api/agent/conversations")]
async fn list_conversations(
    pool: web::Data<Pool>,
    query: web::Query<ScenarioIdQuery>,  // { scenario_id: String }
) -> AppResult<HttpResponse>

/// Get messages for a conversation
#[get("/api/agent/conversations/{id}/messages")]
async fn get_messages(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse>

/// Delete a conversation (and its messages via CASCADE)
#[delete("/api/agent/conversations/{id}")]
async fn delete_conversation(
    pool: web::Data<Pool>,
    path: web::Path<String>,
) -> AppResult<HttpResponse>
```

---

## 6. New Cargo dependencies

Add to `backend/Cargo.toml` `[dependencies]`:

```toml
tokio-stream = "0.1"            # for ReceiverStream (SSE streaming)
```

`tokio` (already included with full features) provides `tokio::process::Command`
and `tokio::io::AsyncBufReadExt`. No other new deps needed.

---

## 7. Handler registration

**Update `backend/src/handlers/mod.rs`:**

```rust
pub mod scenarios;
pub mod factories;
pub mod products;
pub mod demand;
pub mod runs;
pub mod import_export;
pub mod agent;              // ← NEW

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    scenarios::configure(cfg);
    factories::configure(cfg);
    products::configure(cfg);
    demand::configure(cfg);
    runs::configure(cfg);
    import_export::configure(cfg);
    agent::configure(cfg);  // ← NEW
}
```

---

## 8. Frontend types

**Add to `frontend/src/types/index.ts`:**

```typescript
// ---------- Agent ----------

export interface AgentConversation {
  id: string
  scenario_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}
```

---

## 9. Frontend API client

**Add to `frontend/src/api/index.ts`:**

```typescript
// ---------- agent ----------
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

// SSE chat — not using axios; use native EventSource or fetch + ReadableStream
export function agentChatUrl(): string {
  return '/api/agent/chat'
}
```

For the SSE chat itself, the component will use `fetch()` with a `ReadableStream`
reader rather than axios (which doesn't support streaming well):

```typescript
async function sendMessage(
  scenarioId: string,
  message: string,
  conversationId: string | null,
  onChunk: (text: string) => void,
  onDone: (conversationId: string) => void,
  onError: (error: string) => void,
) {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenario_id: scenarioId,
      message,
      conversation_id: conversationId,
    }),
  })

  if (!res.ok || !res.body) {
    onError(`HTTP ${res.status}`)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Parse SSE events
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''  // keep incomplete line
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)
        if (data === '[DONE]') {
          // Extract conversation_id from a header or initial event
          onDone(conversationId ?? '')
          return
        }
        if (data.startsWith('[ERROR]')) {
          onError(data)
          return
        }
        onChunk(data)
      }
    }
  }
}
```

---

## 10. Frontend component: `AgentChat.tsx`

**File: `frontend/src/components/AgentChat.tsx`**

### Structure

```
┌─────────────────────────────────────┐
│ Conversation selector  [+ New] [×]  │
├─────────────────────────────────────┤
│                                     │
│  User message bubble                │
│                                     │
│  Assistant message bubble           │
│  (markdown rendered)                │
│                                     │
│  User message bubble                │
│                                     │
│  █  Typing indicator (streaming)    │
│                                     │
├─────────────────────────────────────┤
│ [Type a message...]          [Send] │
└─────────────────────────────────────┘
```

### Component props

```typescript
interface Props {
  scenarioId: string
}
```

### State

```typescript
const [conversations, setConversations] = useState<AgentConversation[]>([])
const [activeConvId, setActiveConvId] = useState<string | null>(null)
const [messages, setMessages] = useState<AgentMessage[]>([])
const [input, setInput] = useState('')
const [streaming, setStreaming] = useState(false)
const [streamBuffer, setStreamBuffer] = useState('')  // accumulates during SSE
```

### Markdown rendering

Install `react-markdown` (lightweight, ~30KB):

```bash
cd frontend && npm install react-markdown
```

Use in message rendering:

```tsx
import ReactMarkdown from 'react-markdown'

function MessageBubble({ msg }: { msg: AgentMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
        isUser
          ? 'bg-indigo-600 text-white'
          : 'bg-white border border-slate-200 text-slate-800'
      }`}>
        {isUser ? (
          <p>{msg.content}</p>
        ) : (
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        )}
      </div>
    </div>
  )
}
```

---

## 11. App.tsx integration

### Changes needed

```typescript
// 1. Add to Tab type
type Tab = 'factories' | 'products' | 'demand' | 'run' | 'results' | 'agent'

// 2. Add to imports
import { MessageCircle } from 'lucide-react'
const AgentChat = lazy(() =>
  import('./components/AgentChat').then((m) => ({ default: m.AgentChat })),
)

// 3. Add to tabs array (between 'results' and end)
{ key: 'agent', label: 'Agent', icon: MessageCircle },

// 4. Add to tab content rendering
{tab === 'agent' && (
  <Suspense fallback={<div className="p-6 text-slate-500">Loading agent...</div>}>
    <AgentChat scenarioId={activeId} />
  </Suspense>
)}
```

---

## 12. Environment variable

Add to backend:

```rust
let devin_cmd = std::env::var("DEVIN_CMD")
    .unwrap_or_else(|_| "devin".to_string());
```

| Var | Default | Notes |
|---|---|---|
| `DEVIN_CMD` | `devin` | Path to the devin binary. Override if not on PATH. |

---

## 13. Implementation phases

### Phase A — Backend agent module (estimated ~1 day)

1. Create `backend/migrations/0003_agent.sql` (conversation + message tables)
2. Add `AgentConversation`, `AgentMessage`, `AgentChatRequest` to `models.rs`
3. Create `backend/src/handlers/agent.rs`:
   - `build_system_prompt()` — loads scenario data, formats 3-tier context
   - `agent_chat()` — spawns devin, streams SSE, persists messages
   - `list_conversations()`, `get_messages()`, `delete_conversation()`
4. Register in `handlers/mod.rs` and `main.rs`
5. Add `tokio-stream` to `Cargo.toml`
6. Verify: `cargo build` succeeds, manual curl test of `/api/agent/chat`

### Phase B — System prompt engineering (estimated ~0.5 day)

1. Write `DOMAIN_EXPERTISE` constant (scheduling terminology, algorithm behavior)
2. Write `API_REFERENCE` constant (all endpoints with curl examples)
3. Write `RESPONSE_INSTRUCTIONS` constant (output format, temp-file behavior)
4. Implement `load_scenario_stats()` (Tier 1 — always included)
5. Implement `load_scenario_details()` (Tier 2 — first message only)
6. Test with real devin: send a question, verify devin calls the API correctly
7. Iterate on prompt wording until devin reliably:
   - Cites specific numbers (factories, bays, quantities)
   - Calls curl when it needs more data
   - Writes response to the temp file
   - Formats response as clean markdown

### Phase C — Frontend chat panel (estimated ~1 day)

1. `npm install react-markdown` in frontend/
2. Create `frontend/src/components/AgentChat.tsx`:
   - Conversation selector dropdown (+ new, delete)
   - Message list with user/assistant bubbles
   - Markdown rendering for assistant messages
   - Input box + send button
   - SSE streaming via fetch ReadableStream
   - Typing indicator during streaming
   - Auto-scroll to bottom on new messages
3. Add types to `frontend/src/types/index.ts`
4. Add API functions to `frontend/src/api/index.ts`
5. Wire into `App.tsx` as lazy-loaded tab
6. Verify: `npm run build` succeeds

### Phase D — Polish + streaming reliability (estimated ~0.5 day)

1. Handle devin process failures gracefully (exit code != 0)
2. Handle client disconnection during streaming (abort devin process)
3. Conversation title auto-generation (first user message, truncated to 60 chars)
4. Clear temp files on startup (in case of prior crashes)
5. Loading state when conversation history is loading
6. Empty state: "Ask the scheduling expert a question about this scenario"
7. Error messages in chat UI (network errors, timeouts)
8. Final `cargo test` + `npm run build` + manual end-to-end test
9. Commit

**Rough total: ~3 focused days**

---

## 14. Testing strategy

### Manual testing scenarios

1. **Basic Q&A**: "How many bays does Factory A have?" — devin should answer from context without calling API
2. **Analysis**: "Why are Q3 units unshippable?" — devin should analyze demand vs capacity
3. **What-if**: "What if we add 2 bays to Factory B in Q3?" — devin should clone scenario, modify, run, compare
4. **Multi-turn**: Follow-up "What about reducing Widget lead time instead?" — devin should use conversation context
5. **Data modification**: "Add a new demand row: 15 Gadgets in Q4 2026" — devin should call POST /api/demand
6. **Timeout**: Send a very complex request and verify timeout handling works
7. **Error recovery**: Kill devin mid-stream and verify frontend handles it gracefully

### Automated tests

- Unit test `build_system_prompt()` with mock scenario data (verify output format)
- Unit test SSE event formatting
- No automated tests for devin interaction itself (too slow, non-deterministic)

---

## 15. File inventory (new/modified files)

### New files
```
backend/migrations/0003_agent.sql           — DB migration
backend/src/handlers/agent.rs               — Agent handler (chat, conversations)
frontend/src/components/AgentChat.tsx        — Chat panel component
```

### Modified files
```
backend/Cargo.toml                          — add tokio-stream
backend/src/handlers/mod.rs                 — register agent module
backend/src/models.rs                       — add AgentConversation, AgentMessage, AgentChatRequest
frontend/package.json                       — add react-markdown
frontend/src/types/index.ts                 — add AgentConversation, AgentMessage types
frontend/src/api/index.ts                   — add conversation API functions
frontend/src/App.tsx                        — add Agent tab
```

---

## 16. Deferred / future enhancements

- **Suggested prompts**: pre-built buttons ("Analyze shortfall", "Compare factories", "Optimize lead times") that populate the chat input
- **Scenario diff view**: when agent creates a what-if clone, show a side-by-side comparison
- **Agent memory**: persist learned preferences/context across conversations
- **Multi-model support**: add OpenAI/Anthropic as alternative backends if devin is unavailable
- **Rate limiting**: prevent accidental devin-process storms
- **Prompt caching**: cache scenario snapshots and only rebuild when data changes

---

## 17. Quick reference: existing codebase patterns

For the implementer picking this up:

| Pattern | Where to look | How to follow it |
|---|---|---|
| New handler module | `handlers/runs.rs` | `pub fn configure(cfg)`, register service(s) |
| DB migration | `migrations/0002_factory_bay_count.sql` | CREATE TABLE with indexes, FK + CASCADE |
| Model structs | `models.rs` lines 28-77 (Factory) | `#[derive(Debug, Clone, Serialize, sqlx::FromRow)]` |
| Error handling | `error.rs` | Return `AppResult<HttpResponse>`, use `AppError::*` |
| ID generation | `db.rs` → `new_id()` | UUID v4 string |
| Timestamp | `db.rs` → `now_iso()` | RFC3339 UTC |
| Frontend API func | `api/index.ts` | `client.get(...).then(r => r.data).catch(rethrow)` |
| Frontend type | `types/index.ts` | Interface mirroring backend Serialize struct |
| Lazy component | `App.tsx` line 18 (GanttView) | `const X = lazy(() => import(...).then(m => ({ default: m.X })))` |
| Tab addition | `App.tsx` lines 80-86 | Add to `Tab` type, `tabs` array, content switch |
| New npm dep | `package.json` | `npm install react-markdown` |
| New cargo dep | `Cargo.toml` | Add line, `cargo build` to verify |

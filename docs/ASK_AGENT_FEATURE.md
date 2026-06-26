# Ask Agent — How It Works

The **Ask Agent** feature ("Agent" tab in the UI) is a Devin-powered chat assistant
embedded inside *factoryplan*. It lets a user ask natural-language questions about the
current production-scheduling scenario — *"Why are some units unshippable?"*, *"What's
the cheapest way to clear the shortfall?"*, *"Run a what-if with 2 more bays in Q3"* —
and get expert, quantitative answers grounded in the live scenario data.

Under the hood it shells out to the local `devin` CLI in print mode, feeds it a richly
constructed prompt (domain expertise + API reference + a snapshot of the scenario), and
streams the agent's response back to the browser over Server-Sent Events (SSE).

> **Prefer a guided, visual walkthrough?** There's an interactive explainer (animated
> diagrams, a step-through of the request flow, a layered-prompt explorer, and clickable
> mock-ups of the proposed advancements) in [`explainer/`](./explainer/). Run it with
> `cd docs/explainer && npm install && npm run dev` (Vite + React, opens on `:5180`).

---

## 1. Architecture at a glance

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ Browser (React)                                                              │
 │                                                                              │
 │  AgentChat.tsx ──► api.sendAgentMessage()  (fetch + ReadableStream, SSE)     │
 │     ▲  conversation list / messages (axios)                                  │
 └─────┼────────────────────────────────────────────────────────────────────────
       │  POST /api/agent/chat            GET /api/agent/conversations
       │  (text/event-stream)             GET /.../{id}/messages
       │                                  DELETE /.../{id}
 ┌─────┼────────────────────────────────────────────────────────────────────────
 │ Backend (Rust / actix-web)            handlers/agent.rs                       │
 │                                                                              │
 │  agent_chat()                                                                │
 │    1. validate scenario + get/create conversation   ┌──────────────────────┐ │
 │    2. load history, persist user msg  ───────────►  │ SQLite                │ │
 │    3. build_system_prompt()  (domain + API + data)  │  agent_conversation   │ │
 │    4. write prompt to temp file                     │  agent_message        │ │
 │    5. spawn_devin_stream() ─────────┐               │  scenario/factory/... │ │
 │                                     │               └──────────────────────┘ │
 │       ┌─────────────────────────────▼──────────────────────────────────────┐ │
 │       │ tokio: spawn `devin -p --prompt-file <tmp> --permission-mode ...`   │ │
 │       │   stream stdout line-by-line as `data:` SSE events                  │ │
 │       │   devin may call back into the API via `curl` (exec tool)  ─────────┼─┼─► /api/...
 │       │   persist assistant message on completion                          │ │
 │       └────────────────────────────────────────────────────────────────────┘ │
 └────────────────────────────────────────────────────────────────────────────┘
```

Key source files:

- Backend handler: <ref_file file="C:\Users\pdangol\CascadeProjects\factoryplan-rust\backend\src\handlers\agent.rs" />
- DB schema: <ref_file file="C:\Users\pdangol\CascadeProjects\factoryplan-rust\backend\migrations\0003_agent.sql" />
- Frontend chat UI: <ref_file file="C:\Users\pdangol\CascadeProjects\factoryplan-rust\frontend\src\components\AgentChat.tsx" />
- Frontend API/SSE client: <ref_file file="C:\Users\pdangol\CascadeProjects\factoryplan-rust\frontend\src\api\index.ts" />

---

## 2. Request flow diagram

```
User types message ──► AgentChat.send()
        │  optimistic user bubble + "Thinking…" spinner
        ▼
api.sendAgentMessage()  POST /api/agent/chat  { scenario_id, message, conversation_id }
        │
        ▼
agent_chat() (Rust)
   ├─ verify scenario exists            (404 if missing)
   ├─ get-or-create conversation        (new id + auto title if none)
   ├─ load prior history (BEFORE insert)
   ├─ persist user message + bump updated_at
   ├─ build_system_prompt(scenario, first_message?)
   │      DOMAIN_EXPERTISE + api_reference() + scenario snapshot + response_instructions()
   ├─ format_devin_input(prompt, history, user_msg)
   ├─ write prompt → %TEMP%/factoryplan_agent_input_<conv>.txt
   └─ spawn_devin_stream(...)  ─────► returns HTTP 200 text/event-stream
                │
                ▼  (background tokio task)
        data: [CONV] <conversation_id>          ← sent first
        spawn  devin -p --prompt-file <tmp> --permission-mode dangerous
            │
            │  (devin may run `curl` against /api/... to fetch data / run what-ifs)
            ▼
        for each stdout line:  data: <line>      ← streamed to browser
            (180s hard timeout; client-disconnect kills the child)
        on EOF: persist assistant message
        data: [DONE]                            ← or  data: [ERROR] <msg>
                │
                ▼
AgentChat handlers: onConversation / onChunk / onError / onDone
   └─ refreshAfterTurn(): reload conversation list + persisted messages
```

---

## 3. Backend walkthrough (with snippets)

### 3.1 Routes

All agent endpoints are registered in `configure()`:

```rust
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(agent_chat)            // POST   /api/agent/chat            (SSE)
        .service(list_conversations)   // GET    /api/agent/conversations
        .service(get_messages)         // GET    /api/agent/conversations/{id}/messages
        .service(delete_conversation); // DELETE /api/agent/conversations/{id}
}
```

### 3.2 The chat endpoint

`agent_chat` does validation, conversation bookkeeping, prompt construction, and then
hands off to a streaming function. Note the ordering detail: **history is loaded before
the new user message is inserted**, so the current turn isn't duplicated into the context.

```rust
// Load prior history BEFORE inserting the new user message.
let history = sqlx::query_as::<_, AgentMessage>(
    "SELECT ... FROM agent_message WHERE conversation_id = ? ORDER BY created_at",
).bind(&conv_id).fetch_all(pool.get_ref()).await?;

// Persist the user message.
sqlx::query("INSERT INTO agent_message (...) VALUES (?, ?, 'user', ?, ?)")...

// Build the prompt (first message gets the full Tier-2 detail block).
let system_prompt = build_system_prompt(pool.get_ref(), &scenario, history.is_empty()).await?;
let devin_input = format_devin_input(&system_prompt, &history, &user_msg);

// Write the prompt to a temp file (Windows-safe temp dir).
let input_path = std::env::temp_dir().join(format!("factoryplan_agent_input_{conv_id}.txt"));
std::fs::write(&input_path, &devin_input)?;

let stream = spawn_devin_stream(pool.get_ref().clone(), conv_id.clone(), input_path);
Ok(HttpResponse::Ok()
    .content_type("text/event-stream")
    .insert_header(("Cache-Control", "no-cache"))
    .insert_header(("X-Accel-Buffering", "no"))   // disable proxy buffering
    .streaming(stream))
```

The prompt is passed via a **temp file** (`--prompt-file`) rather than a CLI argument so
that large prompts and special characters are handled safely on Windows.

### 3.3 Spawning Devin and streaming output

`spawn_devin_stream` runs the CLI in a background tokio task and pushes each stdout line
into an mpsc channel that backs the SSE response stream. It implements a small event
protocol on top of SSE:

| Event                       | Meaning                                              |
|-----------------------------|------------------------------------------------------|
| `data: [CONV] <id>`         | Sent once, first — lets the client pin a new conv id |
| `data: <line>`              | One line of the assistant's answer                   |
| `data: [ERROR] <message>`   | Fatal error; stream ends after this                  |
| `data: [DONE]`              | Normal completion                                    |

```rust
let _ = tx.send(Ok(sse(&format!("[CONV] {conv_id}")))).await; // announce id first

let spawn_result = tokio::process::Command::new(devin_cmd())
    .arg("-p")                          // print (non-interactive) mode
    .arg("--prompt-file").arg(&input_arg)
    .arg("--permission-mode").arg("dangerous")  // allow the exec/curl tool
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)                 // child dies if the stream is dropped
    .spawn();
```

Robustness details worth calling out:

- **180s hard timeout** (`DEVIN_TIMEOUT_SECS`) — long turns are killed and reported as
  `[ERROR] Agent timed out`.
- **Client disconnect handling** — if `tx.send` fails (browser closed the stream), the
  child is killed and the temp file removed.
- **stderr is drained on a background task** so a full pipe can never block the child.
- **Empty-output diagnostics** — if the agent prints nothing, stderr / exit status is
  surfaced as a useful `[ERROR]` instead of an empty bubble.
- **Persistence** — the assistant message is only written to SQLite if non-empty.
- **Temp-file cleanup** — `cleanup_temp_files()` (called at startup) sweeps stale
  `factoryplan_agent_input_*` files left by a prior crash.

```rust
fn sse(line: &str) -> Bytes {
    Bytes::from(format!("data: {line}\n\n"))
}
```

### 3.4 Conversation persistence

A simple two-table schema scoped per scenario, with `ON DELETE CASCADE`:

```sql
CREATE TABLE agent_conversation (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    title TEXT,                 -- auto-generated from the first user message
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE agent_message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

---

## 4. What context the agent has when invoked

The prompt sent to Devin is assembled by `build_system_prompt()`:

```rust
async fn build_system_prompt(pool, scenario, include_details) -> AppResult<String> {
    let mut p = String::new();
    p.push_str(DOMAIN_EXPERTISE);                                       // (1)
    p.push_str(&api_reference());                                       // (2)
    p.push_str(&format_scenario_context(pool, scenario, include_details).await?); // (3)
    p.push_str(&response_instructions());                               // (4)
    Ok(p)
}
```

Then `format_devin_input()` appends the **conversation history** and the **current user
message**. So a single turn's full context is:

**(1) Domain expertise** (`DOMAIN_EXPERTISE`, static) — teaches the model the scheduling
vocabulary: lead time / cycle time, bays, backward scheduling, demand explosion,
unshippable units, and cross-quarter window rules. This makes answers domain-correct
without the user re-explaining the model each time.

**(2) API reference** (`api_reference()`) — a live list of GET/POST/PUT endpoints (with
the actual base URL derived from `HOST`/`PORT`) so the agent can `curl` for data beyond
the snapshot or run what-if experiments. It explicitly instructs: *clone the scenario
before mutating, never touch the user's active scenario unless asked.*

**(3) Scenario snapshot** (`format_scenario_context()`), in two tiers to control prompt
size:

- **Tier 1 — always included:** scenario name/id, factory count + total bays, product
  count, demand rows + total units, and a one-line summary of the latest run
  (total / shipped on time / unshippable / % fill).
- **Tier 2 — only on the first message of a conversation** (`include_details =
  history.is_empty()`): the full detail block from `format_scenario_details()` —
  per-factory bay matrix incl. per-quarter overrides, per-product lead times by quarter,
  and demand broken down by period. This avoids re-sending the heavy snapshot on every
  follow-up turn.

**(4) Response instructions** (`response_instructions()`) — formatting/behavior rules:
lead with the conclusion, interpret data (don't dump raw JSON), use clean Markdown, be
concise, and **print only the final answer to stdout** (critical — stdout is the SSE
stream).

**(5) Conversation history + current message** — appended by `format_devin_input()`:

```rust
s.push_str("\n\n## Conversation so far\n\n");
for m in history {
    let who = match m.role.as_str() { "user" => "User", "assistant" => "You (assistant)", _ => "System" };
    s.push_str(&format!("### {who}\n{}\n\n", m.content));
}
s.push_str("\n\n## Current user message\n\n");
s.push_str(user_msg);
```

> In short: **static domain knowledge + a live API it can call + a data snapshot of the
> current scenario + the chat history**. Crucially, the agent isn't limited to the
> snapshot — via the `exec`/`curl` tool it can fetch exact per-unit assignments and even
> run the scheduler on a cloned scenario to test changes.

---

## 5. Frontend walkthrough

`AgentChat.tsx` is a self-contained chat panel keyed by `scenarioId`:

- Loads the conversation list when the scenario changes; loads messages when the active
  conversation changes.
- On send, it optimistically renders the user's bubble, shows a streaming "Thinking…"
  bubble, then appends streamed chunks live.
- Renders assistant content as Markdown (`react-markdown`).
- Offers starter **suggestion chips** for an empty conversation.

The streaming itself can't use axios (no streaming), so `sendAgentMessage()` uses
`fetch` + `ReadableStream` and parses SSE frames manually:

```ts
// SSE events are separated by a blank line; each event has `data:` lines.
while ((sep = buffer.indexOf('\n\n')) !== -1) {
  const rawEvent = buffer.slice(0, sep)
  buffer = buffer.slice(sep + 2)
  const data = rawEvent.split('\n').filter(l => l.startsWith('data:'))
                       .map(l => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n')

  if (data.startsWith('[CONV] '))      handlers.onConversation?.(data.slice(7).trim())
  else if (data === '[DONE]')          { handlers.onDone(); return }
  else if (data.startsWith('[ERROR]')) { handlers.onError(data.slice(7).trim()); return }
  else                                 handlers.onChunk(data)
}
```

`sendAgentMessage` returns an `AbortController`, so navigating away or starting a new
conversation aborts the in-flight request (which the backend detects and uses to kill the
Devin process).

---

## 6. How to implement a similar feature in another project

The pattern is *"LLM CLI as a subprocess, streamed over SSE, grounded with a generated
prompt and a callable API."* To replicate it:

1. **Pick the agent runtime.** Here it's the `devin` CLI invoked in print mode
   (`-p --prompt-file <file> --permission-mode dangerous`). Any CLI/SDK that (a) accepts
   a prompt and (b) streams tokens/lines to stdout works — e.g. another agent CLI, or an
   OpenAI/Anthropic streaming SDK call. Make the command configurable via env var
   (`DEVIN_CMD`) for testability.

2. **Add persistence.** Two tables — `conversation` (scoped to your domain entity) and
   `message` (role + content + timestamp) — with cascade delete. Load history *before*
   inserting the new user message.

3. **Build a layered system prompt.** Separate static and dynamic parts:
   - Static: domain expertise + behavior/formatting rules.
   - Dynamic: a snapshot of the relevant entity's state, generated from your DB.
   - Use **tiering** — send the heavy detail block only on the first turn; send a light
     summary on every turn — to keep prompts small and fast.
   - Include an **API reference** so the agent can fetch more data or take actions, and
     give explicit safety rules (e.g. *clone before mutating*).

4. **Stream over SSE.** Spawn the subprocess, read stdout line-by-line, and forward each
   line as a `data:` event. Define a tiny protocol for out-of-band signals
   (`[CONV]`, `[DONE]`, `[ERROR]`). Set `Cache-Control: no-cache` and
   `X-Accel-Buffering: no`.

5. **Be defensive about the subprocess:**
   - Hard timeout + kill on expiry.
   - `kill_on_drop` / detect client disconnect (failed send) → kill the child.
   - Drain stderr on a separate task so the pipe never blocks.
   - Surface empty-output / non-zero-exit as a real error message.
   - Clean up temp prompt files (and sweep stale ones at startup).
   - Pass the prompt via a **file**, not an argv string (cross-platform, large inputs).

6. **Frontend.** Use `fetch` + `ReadableStream` (axios/`EventSource` won't do POST
   streaming cleanly), parse SSE frames, render Markdown, support optimistic UI +
   abort-on-navigate, and persist/reload conversations after each turn.

---

## 7. Ideas to enhance the agentic experience

Grouped by impact. None of these exist today; they're suggestions building on the
current design.

**Richer streaming / transparency**
- **Token-level streaming** instead of line-buffered — smoother typing effect.
- **Tool-call trace panel** — surface which `curl`/exec calls the agent made (an
  optional `[TOOL] ...` event channel) so users can audit how an answer was derived.
- **Progress / status events** — `[STATUS] running scheduler…` to fill the dead air
  during long what-if runs instead of a generic spinner.

**Deeper integration with the app**
- **Structured action results** — when the agent runs/clones a scenario, emit a typed
  event (`[RESULT] {run_id}`) so the UI can render the Gantt chart or a results table
  inline rather than as text.
- **"Apply this change" button** — let the agent propose a diff (e.g. +2 bays in Q3) that
  the user approves with one click, rather than the agent mutating data directly.
- **Deep links / citations** — let answers link to the relevant factory/product editor
  or a specific unit in the Gantt view.

**Context & memory**
- **Smarter context selection** — currently Tier-2 detail is sent only on turn 1; for
  long chats, re-inject changed entities or summarize old turns to avoid context drift.
- **Conversation summarization** — compress old messages once history grows to keep
  prompts within budget.
- **Cross-scenario / portfolio questions** — allow the agent to compare multiple
  scenarios in one answer.

**Safety, cost, and reliability**
- **Read-only mode toggle** — drop `--permission-mode dangerous` for users who only want
  Q&A, eliminating any mutation risk.
- **Confirmation gate for writes** — require explicit user approval before the agent
  POST/PUTs to the API.
- **Rate limiting / concurrency cap** — one in-flight turn per conversation; queue or
  reject others.
- **Caching** — cache the scenario snapshot per turn (already cheap) and memoize
  identical recent questions.

**UX**
- **Stop button** — expose the existing `AbortController` as a visible "Stop generating".
- **Regenerate / edit-and-resend** a previous turn.
- **Export conversation** to Markdown/PDF alongside the existing run exports.
- **Voice or quick-action chips** generated dynamically from the scenario (e.g. "Why is
  {bottleneck factory} overloaded?").

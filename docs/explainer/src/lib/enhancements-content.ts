export type Detail = {
  problem: string;
  approach: { title: string; body: string }[];
  code: { file: string; lang: string; body: string };
  changes: string[];
  pros: string[];
  cons: string[];
};

export const DETAILS: Record<string, Detail> = {
  "tool-trace": {
    problem:
      "Today the agent silently runs curl/exec calls and you only see the final prose. If a number looks off, there's no way to tell whether the agent read stale data, hit the wrong endpoint, or reasoned incorrectly. That erodes trust for high-stakes planning decisions.",
    approach: [
      {
        title: "Add a [TOOL] event channel to the SSE protocol",
        body: "When devin emits a tool call, surface it as a distinct event line (e.g. data: [TOOL] {json}) alongside the existing answer lines. The frontend routes [TOOL] events to a collapsible side panel instead of the message body.",
      },
      {
        title: "Capture method, URL, status, latency",
        body: "Wrap the exec/curl invocations so each one logs a small structured record. Persist them on the assistant message (a new agent_tool_call table keyed by message_id) so the trace survives a reload.",
      },
      {
        title: "Render an auditable timeline",
        body: "A panel lists each call with status + duration and expands to show the request and a snippet of the response — exactly like a browser network tab, scoped to one answer.",
      },
    ],
    code: {
      file: "SSE protocol extension",
      lang: "rust",
      body: `// New control event, emitted whenever devin reports a tool use.
data: [TOOL] {"method":"GET","url":"/api/runs/run_8f2","status":200,"ms":42}

// frontend api/index.ts — route it to a separate handler:
else if (data.startsWith('[TOOL] ')) {
  handlers.onTool?.(JSON.parse(data.slice(7)))
} else if (data === '[DONE]') { ... }`,
    },
    changes: [
      "agent.rs: emit a [TOOL] SSE line per tool call; add agent_tool_call table.",
      "api/index.ts: add onTool handler to the SSE parser.",
      "AgentChat.tsx: add a collapsible 'Agent activity' panel per assistant turn.",
    ],
    pros: [
      "Builds trust — every claim is traceable to a real API call.",
      "Powerful for debugging bad answers.",
      "Reuses the existing SSE protocol; no new transport.",
    ],
    cons: [
      "Requires devin to expose tool events on stdout (or parse them out).",
      "Extra UI surface and a new table to maintain.",
    ],
  },

  "structured-results": {
    problem:
      "When the agent runs the scheduler, the rich result (per-unit bay assignments, fill rate, Gantt) is flattened into text. The app already has a beautiful GanttView component — but the chat can't reuse it, so users re-read numbers they could have seen visually.",
    approach: [
      {
        title: "Emit a typed [RESULT] event",
        body: "When the agent runs or clones a scenario, have it print a machine-readable marker like data: [RESULT] {\"run_id\":\"run_9c4\"} in addition to its prose.",
      },
      {
        title: "Hydrate real components inline",
        body: "On [RESULT], the frontend fetches GET /api/runs/{run_id} and renders the existing GanttView / ShipmentSummary right inside the chat bubble — no reimplementation.",
      },
      {
        title: "Make answers actionable",
        body: "The inline chart becomes a launch point: 'open in full Gantt view', 'compare to active scenario', etc.",
      },
    ],
    code: {
      file: "frontend — handle [RESULT]",
      lang: "ts",
      body: `else if (data.startsWith('[RESULT] ')) {
  const { run_id } = JSON.parse(data.slice(9))
  handlers.onResult?.(run_id)   // -> fetch run + render <GanttView/>
}

// In AgentChat, a result attaches to the message:
<MessageBubble msg={m}>
  {m.runId && <Suspense><GanttView runId={m.runId} compact /></Suspense>}
</MessageBubble>`,
    },
    changes: [
      "Reuse GanttView/ShipmentSummary in a 'compact' mode.",
      "agent.rs prompt: instruct the agent to print [RESULT] {run_id} after a run.",
      "Store run_id on the assistant message for replay.",
    ],
    pros: [
      "Massive UX upgrade for near-zero new rendering code (reuse).",
      "Bridges the chat and the rest of the app.",
    ],
    cons: [
      "Relies on the agent emitting the marker reliably (prompt-engineering).",
      "Couples chat rendering to run-result shape.",
    ],
  },

  "apply-diff": {
    problem:
      "The agent currently has dangerous permissions and can mutate data directly, or it just describes a change in prose that the user must re-enter by hand. Neither is great: one is risky, the other is tedious.",
    approach: [
      {
        title: "Agent proposes, never disposes",
        body: "Switch the default to read-only. For changes, the agent emits a structured [PROPOSAL] describing the exact PUT/POST it would make plus a projected impact (from a dry-run on a clone).",
      },
      {
        title: "One-click human approval",
        body: "The frontend renders the proposal as a red/green diff with the projected before/after. 'Apply' performs the write; 'Dismiss' discards it. The active scenario is only ever touched on explicit approval.",
      },
      {
        title: "Verify with a clone first",
        body: "Before proposing, the agent clones the scenario, applies the change, runs it, and reports the delta — so the projected impact shown to the user is real, not guessed.",
      },
    ],
    code: {
      file: "[PROPOSAL] payload",
      lang: "ts",
      body: `data: [PROPOSAL] {
  "summary": "Add 2 bays to Riverside Q3",
  "request": { "method":"PUT", "url":"/api/factories/riverside",
               "body": { "bays_q3": 12 } },
  "projected": { "unshippable": [18, 4], "fill": [0.92, 0.98] }
}

// Apply button just replays the request the agent already validated.
await fetch(p.request.url, { method: p.request.method, body: ... })`,
    },
    changes: [
      "agent.rs prompt: define the [PROPOSAL] contract; default to read-only.",
      "New ProposalCard component with apply/dismiss.",
      "Optional: an /api/proposals audit log.",
    ],
    pros: [
      "Safe by default — humans stay in the loop for writes.",
      "Eliminates copy-paste; the agent does the work, the user just approves.",
      "Projected impact is verified on a clone, not hallucinated.",
    ],
    cons: [
      "More moving parts (proposal schema, dry-run cloning).",
      "Largest build of the six.",
    ],
  },

  "read-only-mode": {
    problem:
      "The agent always spawns with --permission-mode dangerous, meaning it can POST/PUT/DELETE against the live scenario at any time. For a Q&A user that's unnecessary risk; there's no way to say 'just answer, don't touch anything.'",
    approach: [
      {
        title: "A permission toggle",
        body: "Expose a per-conversation (or global) read-only switch. In read-only mode, spawn devin with a 'safe' permission profile so writes are blocked at the source, not just discouraged by the prompt.",
      },
      {
        title: "Confirmation gate for writes",
        body: "When writes are allowed, don't let them auto-commit. Pause on each mutating request and require explicit user approval (pairs naturally with Propose-and-Apply).",
      },
      {
        title: "Defense in depth",
        body: "Combine the spawn flag (can't write) with prompt rules (shouldn't write) so a single failure doesn't expose the live scenario.",
      },
    ],
    code: {
      file: "agent.rs — choose the profile",
      lang: "rust",
      body: `let mode = if req.read_only { "safe" } else { "dangerous" };
Command::new(devin_cmd())
    .arg("-p").arg("--prompt-file").arg(&input_arg)
    .arg("--permission-mode").arg(mode)   // gate at the source
    .stdout(Stdio::piped()).kill_on_drop(true).spawn();`,
    },
    changes: [
      "Add read_only to AgentChatRequest + a UI toggle.",
      "Map it to the devin permission flag.",
      "Adjust the prompt's API-reference section to hide writes in read-only mode.",
    ],
    pros: [
      "Tiny change, big risk reduction — the highest-leverage quick win.",
      "Foundational for any production deployment.",
    ],
    cons: [
      "Read-only disables what-if runs (which need to clone+run).",
      "Requires the CLI to honor a safe permission profile.",
    ],
  },

  "context-memory": {
    problem:
      "Tier-2 detail is sent only on turn 1. If the user edits a factory mid-conversation, the agent's mental model goes stale. And in long chats, replaying full history will eventually blow the context window.",
    approach: [
      {
        title: "Re-inject changed entities",
        body: "Track an updated_at watermark per scenario. On each turn, diff against the last turn and re-send only the entities that changed since — keeping the snapshot fresh without resending everything.",
      },
      {
        title: "Summarize old turns",
        body: "Once history exceeds a budget, replace the oldest turns with a short rolling summary (generated by the agent itself) so the prompt stays bounded.",
      },
      {
        title: "Budget-aware assembly",
        body: "Compose the prompt against a token budget: pin the system layers, then fill with as much recent verbatim history as fits, falling back to the summary.",
      },
    ],
    code: {
      file: "format_scenario_context() — delta mode",
      lang: "rust",
      body: `// Re-send only what changed since the last turn of this conversation.
let changed = sqlx::query_as::<_, Factory>(
    "SELECT * FROM factory WHERE scenario_id = ? AND updated_at > ?"
).bind(scenario_id).bind(&last_turn_at).fetch_all(pool).await?;

if !changed.is_empty() {
    s.push_str("\\n### Updated since last turn\\n");
    // ...render only the deltas
}`,
    },
    changes: [
      "Track last-turn timestamp per conversation.",
      "Add a delta path to scenario-context building.",
      "Add a summarization step when history exceeds N turns.",
    ],
    pros: [
      "Keeps answers correct after mid-chat edits.",
      "Bounds prompt size for arbitrarily long chats.",
    ],
    cons: [
      "Summarization adds an extra agent round-trip / cost.",
      "Delta logic must be careful not to drop needed context.",
    ],
  },

  "token-streaming": {
    problem:
      "The backend streams line-by-line, so text arrives in chunks rather than smoothly, and there's no visible way to stop a long or off-track answer (the AbortController exists but isn't exposed as a button).",
    approach: [
      {
        title: "Token-level streaming",
        body: "If the CLI can emit token deltas, forward them as they arrive instead of buffering whole lines — yielding a smooth typewriter effect.",
      },
      {
        title: "Status events",
        body: "Emit data: [STATUS] running scheduler… during long tool calls so the dead air becomes informative progress instead of a generic spinner.",
      },
      {
        title: "A real Stop button",
        body: "Surface the existing AbortController as a visible control. Aborting the fetch closes the SSE stream, which the backend already detects (failed send) and uses to kill the child process.",
      },
    ],
    code: {
      file: "AgentChat.tsx — expose Stop",
      lang: "ts",
      body: `// abortRef already holds the controller from sendAgentMessage().
{streaming && (
  <button onClick={() => abortRef.current?.abort()}>
    <Square /> Stop
  </button>
)}
// backend: tx.send fails -> child.start_kill() (already implemented)`,
    },
    changes: [
      "Forward token deltas if available; otherwise keep line mode.",
      "Add [STATUS] events around long tool calls.",
      "Render a Stop button bound to the existing AbortController.",
    ],
    pros: [
      "Smoother, more responsive feel.",
      "Stop is nearly free — the plumbing already exists.",
    ],
    cons: [
      "Token deltas depend on what the CLI exposes.",
      "More frequent SSE events = slightly more overhead.",
    ],
  },
};

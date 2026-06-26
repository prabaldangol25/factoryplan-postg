
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Database,
  FileText,
  TerminalSquare,
  Radio,
  Save,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";

type Step = {
  n: number;
  side: "frontend" | "backend" | "devin";
  icon: LucideIcon;
  title: string;
  body: string;
  code?: string;
  emphasis?: string;
};

const STEPS: Step[] = [
  {
    n: 1,
    side: "frontend",
    icon: Radio,
    title: "User sends a message",
    body: "AgentChat optimistically renders the user bubble + a 'Thinking…' spinner, then opens a streaming POST. It can't use axios (no streaming), so it uses fetch + ReadableStream.",
    code: `fetch('/api/agent/chat', {
  method: 'POST',
  body: JSON.stringify({ scenario_id, message, conversation_id }),
  signal: controller.signal,   // abortable
})`,
    emphasis: "The returned AbortController lets the UI cancel a turn — which the backend detects to kill devin.",
  },
  {
    n: 2,
    side: "backend",
    icon: ShieldCheck,
    title: "Validate & get-or-create conversation",
    body: "The handler verifies the scenario exists (404 if not), then either loads the given conversation or creates a new one with an auto-generated title from the first message.",
    code: `let scenario = sqlx::query_as::<_, Scenario>("SELECT … WHERE id = ?")
    .bind(&scenario_id).fetch_optional(pool).await?
    .ok_or_else(|| AppError::NotFound(...))?;`,
  },
  {
    n: 3,
    side: "backend",
    icon: Database,
    title: "Load history BEFORE inserting",
    body: "Prior messages are read first, then the new user message is persisted. Order matters: this stops the current turn from being duplicated into its own context.",
    code: `// Load prior history BEFORE inserting the new user message.
let history = sqlx::query_as::<_, AgentMessage>("SELECT … ORDER BY created_at")…;
// Then persist the user message.
sqlx::query("INSERT INTO agent_message (…) VALUES (?, ?, 'user', ?, ?)")…`,
    emphasis: "A subtle but important sequencing detail.",
  },
  {
    n: 4,
    side: "backend",
    icon: FileText,
    title: "Build the prompt → temp file",
    body: "DOMAIN_EXPERTISE + API reference + a scenario snapshot + response rules + history are concatenated and written to a temp file (not an argv string — safe for big inputs & Windows).",
    code: `let system_prompt = build_system_prompt(pool, &scenario, history.is_empty()).await?;
let devin_input = format_devin_input(&system_prompt, &history, &user_msg);
std::fs::write(&input_path, &devin_input)?;`,
    emphasis: "history.is_empty() decides whether the heavy 'Tier-2' detail block is included.",
  },
  {
    n: 5,
    side: "devin",
    icon: TerminalSquare,
    title: "Spawn devin, stream stdout",
    body: "A background tokio task runs the CLI in print mode and forwards each stdout line as an SSE event. devin may call back into the API with curl to fetch data or run what-ifs.",
    code: `Command::new(devin_cmd())
  .arg("-p").arg("--prompt-file").arg(&input_arg)
  .arg("--permission-mode").arg("dangerous")
  .stdout(Stdio::piped()).kill_on_drop(true).spawn();`,
    emphasis: "180s hard timeout · kill_on_drop · stderr drained on a separate task.",
  },
  {
    n: 6,
    side: "backend",
    icon: Radio,
    title: "SSE event protocol",
    body: "A tiny protocol rides on top of SSE so the client can distinguish control signals from answer text.",
    code: `data: [CONV] <conversation_id>   // sent once, first
data: <line of the answer>       // streamed
data: [ERROR] <message>          // fatal
data: [DONE]                     // normal completion`,
  },
  {
    n: 7,
    side: "backend",
    icon: Save,
    title: "Persist the assistant message",
    body: "On EOF, the accumulated answer is written to SQLite (only if non-empty), the temp file is removed, and [DONE] is emitted.",
    code: `if !trimmed.is_empty() {
  sqlx::query("INSERT INTO agent_message (…) VALUES (?, ?, 'assistant', ?, ?)")…;
}
tx.send(Ok(sse("[DONE]"))).await;`,
  },
  {
    n: 8,
    side: "frontend",
    icon: CheckCircle2,
    title: "Client finalizes the turn",
    body: "onDone fires; the UI reloads the persisted messages and the conversation list (for titles + ordering), replacing the optimistic state with the source of truth.",
    code: `onDone: () => {
  setStreaming(false);
  void refreshAfterTurn(newConvId);  // reload list + messages
}`,
  },
];

const SIDE_STYLE: Record<Step["side"], { label: string; cls: string; dot: string }> = {
  frontend: { label: "Frontend", cls: "text-brand-300 border-brand-500/40 bg-brand-500/10", dot: "bg-brand-400" },
  backend: { label: "Backend", cls: "text-cyan-300 border-accent-cyan/40 bg-cyan-500/10", dot: "bg-accent-cyan" },
  devin: { label: "Subprocess", cls: "text-emerald-300 border-accent-emerald/40 bg-emerald-500/10", dot: "bg-accent-emerald" },
};

export function FlowStepper() {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const side = SIDE_STYLE[step.side];

  return (
    <div className="glass overflow-hidden">
      {/* progress rail */}
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.02] px-4 py-3">
        {STEPS.map((s, idx) => (
          <button
            key={s.n}
            onClick={() => setI(idx)}
            className="group flex flex-1 flex-col items-center gap-1.5"
            title={s.title}
          >
            <span
              className={`h-1.5 w-full rounded-full transition ${
                idx <= i ? SIDE_STYLE[STEPS[i].side].dot : "bg-white/10"
              } ${idx === i ? "ring-2 ring-white/30" : ""}`}
            />
            <span className={`text-[10px] ${idx === i ? "text-white" : "text-slate-600"}`}>
              {s.n}
            </span>
          </button>
        ))}
      </div>

      <div className="p-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={step.n}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.28 }}
          >
            <div className="mb-3 flex items-center gap-3">
              <span className={`chip border ${side.cls}`}>{side.label}</span>
              <span className="text-xs text-slate-500">
                Step {step.n} of {STEPS.length}
              </span>
            </div>

            <div className="flex items-start gap-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5">
                <step.icon className="h-5 w-5 text-slate-200" />
              </span>
              <div>
                <h3 className="text-xl font-semibold text-white">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{step.body}</p>
              </div>
            </div>

            {step.code && (
              <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-ink-950/80 p-4 font-mono text-[12px] leading-relaxed text-slate-300">
                <code>{step.code}</code>
              </pre>
            )}

            {step.emphasis && (
              <p className="mt-3 rounded-lg border border-brand-500/20 bg-brand-500/[0.06] px-3 py-2 text-xs text-brand-200">
                {step.emphasis}
              </p>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => setI((n) => Math.max(0, n - 1))}
            disabled={i === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <button
            onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))}
            disabled={i === STEPS.length - 1}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:opacity-30"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}


import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  ChevronRight,
  Check,
  X,
  Lock,
  Unlock,
  ShieldAlert,
  Square,
  Brain,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* 1. Tool-trace panel                                                 */
/* ------------------------------------------------------------------ */
const TRACE = [
  { cmd: "curl /api/runs/run_8f2", status: 200, ms: 42, note: "fetch latest run" },
  { cmd: "curl /api/scenarios/s1/products", status: 200, ms: 31, note: "lead times" },
  { cmd: "POST /api/scenarios (clone_from=s1)", status: 201, ms: 88, note: "clone for what-if" },
  { cmd: "POST /api/scenarios/s2/run", status: 200, ms: 412, note: "run the clone" },
];

export function ToolTraceMock() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="glass overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
        <Terminal className="h-4 w-4 text-accent-cyan" />
        <span className="text-sm font-medium text-slate-200">Agent activity</span>
        <span className="ml-auto font-mono text-[11px] text-slate-500">4 tool calls · 573ms</span>
      </div>
      <div className="divide-y divide-white/5">
        {TRACE.map((t, i) => (
          <div key={i}>
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-white/[0.03]"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 text-slate-500 transition ${open === i ? "rotate-90" : ""}`}
              />
              <code className="flex-1 truncate font-mono text-[12px] text-slate-300">{t.cmd}</code>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                {t.status}
              </span>
              <span className="w-12 text-right font-mono text-[10px] text-slate-500">{t.ms}ms</span>
            </button>
            <AnimatePresence>
              {open === i && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden bg-ink-950/60 px-11 pb-3 pt-1 text-xs text-slate-400"
                >
                  {t.note}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Inline Gantt result                                              */
/* ------------------------------------------------------------------ */
const BARS = [
  { f: "Riverside", rows: [[2, 5], [4, 8], [6, 9]] },
  { f: "Lakeside", rows: [[1, 4], [5, 9], [7, 10]] },
];
export function InlineGanttMock() {
  return (
    <div className="glass p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-200">run_9c4 · 92% on-time</span>
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
          rendered from [RESULT] event
        </span>
      </div>
      <div className="space-y-3">
        {BARS.map((b) => (
          <div key={b.f}>
            <p className="mb-1 text-[11px] text-slate-400">{b.f}</p>
            <div className="space-y-1">
              {b.rows.map((r, i) => (
                <div key={i} className="relative h-4 rounded bg-white/[0.03]">
                  <motion.div
                    initial={{ width: 0, opacity: 0 }}
                    whileInView={{ width: `${(r[1] - r[0]) * 10}%`, opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.12, duration: 0.5 }}
                    style={{ marginLeft: `${r[0] * 10}%` }}
                    className="h-4 rounded bg-gradient-to-r from-brand-500 to-accent-cyan"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <span key={i} className="flex-1 text-center text-[9px] text-slate-600">
            W{30 + i}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Propose-and-apply diff                                           */
/* ------------------------------------------------------------------ */
export function ApplyDiffMock() {
  const [state, setState] = useState<"propose" | "applied" | "rejected">("propose");
  return (
    <div className="glass overflow-hidden">
      <div className="border-b border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-slate-200">
        Proposed change
      </div>
      <div className="p-4">
        <p className="mb-3 text-sm text-slate-400">
          The agent suggests adding bays to clear the Q3 shortfall:
        </p>
        <div className="space-y-1 font-mono text-[12px]">
          <div className="rounded bg-rose-500/10 px-3 py-1.5 text-rose-300">
            - Riverside · 2025 Q3 · <span className="text-slate-400">10 bays</span>
          </div>
          <div className="rounded bg-emerald-500/10 px-3 py-1.5 text-emerald-300">
            + Riverside · 2025 Q3 · <span className="text-white">12 bays</span>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-400">
          Projected: unshippable <span className="text-rose-300">18</span> →{" "}
          <span className="text-emerald-300">4</span> · fill{" "}
          <span className="text-rose-300">92%</span> → <span className="text-emerald-300">98%</span>
        </div>

        <AnimatePresence mode="wait">
          {state === "propose" ? (
            <motion.div
              key="actions"
              exit={{ opacity: 0 }}
              className="mt-4 flex gap-2"
            >
              <button
                onClick={() => setState("applied")}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
              >
                <Check className="h-4 w-4" /> Apply change
              </button>
              <button
                onClick={() => setState("rejected")}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5"
              >
                <X className="h-4 w-4" /> Dismiss
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`mt-4 rounded-lg px-3 py-2.5 text-sm ${
                state === "applied"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-slate-500/15 text-slate-400"
              }`}
            >
              {state === "applied"
                ? "✓ PUT /api/factories/riverside committed. Re-running scheduler…"
                : "Dismissed. The active scenario was never touched."}{" "}
              <button onClick={() => setState("propose")} className="ml-1 underline">
                reset
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Read-only / confirmation gate                                    */
/* ------------------------------------------------------------------ */
export function ReadOnlyMock() {
  const [readOnly, setReadOnly] = useState(true);
  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {readOnly ? (
            <Lock className="h-4 w-4 text-emerald-300" />
          ) : (
            <Unlock className="h-4 w-4 text-amber-300" />
          )}
          <span className="text-sm font-medium text-slate-200">
            {readOnly ? "Read-only mode" : "Write mode (gated)"}
          </span>
        </div>
        <button
          onClick={() => setReadOnly((v) => !v)}
          className={`relative h-6 w-11 rounded-full transition ${
            readOnly ? "bg-emerald-500/40" : "bg-amber-500/40"
          }`}
        >
          <motion.span
            layout
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white"
            style={{ left: readOnly ? 2 : 22 }}
          />
        </button>
      </div>
      <div className="mt-4 rounded-lg border border-white/10 bg-ink-950/60 p-3 font-mono text-[12px]">
        <span className="text-slate-500">spawn flags →</span>{" "}
        {readOnly ? (
          <span className="text-emerald-300">--permission-mode safe</span>
        ) : (
          <span className="text-amber-300">--permission-mode dangerous</span>
        )}
      </div>
      <div className="mt-3 flex items-start gap-2 text-xs text-slate-400">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        {readOnly
          ? "Agent can curl GET endpoints to read & analyze, but every write is blocked at the source."
          : "Writes allowed — but each POST/PUT pauses for explicit user approval before committing."}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Smart context / memory                                           */
/* ------------------------------------------------------------------ */
export function MemoryMock() {
  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center gap-2">
        <Brain className="h-4 w-4 text-brand-300" />
        <span className="text-sm font-medium text-slate-200">Context window budget over a long chat</span>
      </div>
      <div className="space-y-3">
        {[
          ["Turns 1-4 (verbatim)", 30, "bg-brand-500"],
          ["Turns 5-12 (summarized)", 15, "bg-accent-cyan"],
          ["Changed entities (re-injected)", 20, "bg-accent-amber"],
          ["Free headroom", 35, "bg-white/10"],
        ].map(([label, pct, cls], i) => (
          <div key={label as string}>
            <div className="mb-1 flex justify-between text-[11px] text-slate-400">
              <span>{label}</span>
              <span className="font-mono">{pct}%</span>
            </div>
            <div className="h-2.5 rounded-full bg-white/[0.04]">
              <motion.div
                initial={{ width: 0 }}
                whileInView={{ width: `${pct}%` }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.6 }}
                className={`h-2.5 rounded-full ${cls}`}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Old turns are compressed and only <em>changed</em> data is re-sent, so the prompt never
        blows the budget no matter how long the conversation runs.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. Token streaming + Stop                                           */
/* ------------------------------------------------------------------ */
const WORDS = "Q3 is bay-bound: 18 bays vs a 23-unit peak, so 5 units fall out.".split(" ");
export function StreamingMock() {
  const [n, setN] = useState(0);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    if (n >= WORDS.length) return;
    const id = setTimeout(() => setN((x) => x + 1), 180);
    return () => clearTimeout(id);
  }, [n, running]);

  return (
    <div className="glass p-5">
      <div className="min-h-[3rem] rounded-lg border border-white/10 bg-ink-950/60 p-3 text-sm leading-relaxed text-slate-200">
        {WORDS.slice(0, n).join(" ")}
        {running && n < WORDS.length && (
          <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand-400" />
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setRunning((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5"
        >
          <Square className="h-3.5 w-3.5" /> {running ? "Stop" : "Resume"}
        </button>
        <button
          onClick={() => {
            setN(0);
            setRunning(true);
          }}
          className="text-sm text-brand-300 underline"
        >
          replay
        </button>
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {running ? "● streaming" : "■ stopped (AbortController.abort())"}
        </span>
      </div>
    </div>
  );
}

const DEMOS: Record<string, () => JSX.Element> = {
  "tool-trace": ToolTraceMock,
  "structured-results": InlineGanttMock,
  "apply-diff": ApplyDiffMock,
  "read-only-mode": ReadOnlyMock,
  "context-memory": MemoryMock,
  "token-streaming": StreamingMock,
};

// Wrapper so the (server) detail page can render a demo by slug without
// crossing a client component across the RSC boundary as data.
export function DemoBySlug({ slug }: { slug: string }) {
  const Demo = DEMOS[slug];
  return Demo ? <Demo /> : null;
}

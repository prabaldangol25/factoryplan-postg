
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, User, Send, Loader2, RotateCcw, Terminal } from "lucide-react";

type Phase = "idle" | "thinking" | "tool" | "streaming" | "done";

const QUESTION = "Why are some units unshippable in Q3?";
const TOOL_LINE = "$ curl.exe http://127.0.0.1:8080/api/runs/run_8f2/  →  200 OK";
const ANSWER = `**Q3 is bay-bound, not lead-time-bound.**

Across both factories you have **18 bays** in Q3, but demand explodes to **23 concurrent units** at peak (week 31). The **5 surplus units** can't find a free bay inside their required window, so they fall out as unshippable.

- **Riverside** saturates first (10/10 bays, weeks 30-33)
- **Lakeside** peaks at 8/8 the same weeks
- Pushing 2 units into Q2 (early spread) clears **4 of 5**.`;

export function ChatDemo() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState("");
  const [runId, setRunId] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  function run() {
    clearTimers();
    setTyped("");
    setRunId((n) => n + 1);
    setPhase("thinking");
    timers.current.push(setTimeout(() => setPhase("tool"), 1100));
    timers.current.push(setTimeout(() => setPhase("streaming"), 2300));
  }

  // Typewriter for the streaming phase.
  useEffect(() => {
    if (phase !== "streaming") return;
    let i = 0;
    const id = setInterval(() => {
      i += 3;
      setTyped(ANSWER.slice(0, i));
      if (i >= ANSWER.length) {
        clearInterval(id);
        setPhase("done");
      }
    }, 16);
    return () => clearInterval(id);
  }, [phase, runId]);

  useEffect(() => {
    run();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="glass overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-500/20">
          <Bot className="h-3.5 w-3.5 text-brand-300" />
        </span>
        <span className="text-sm font-medium text-slate-200">Scheduling Expert</span>
        <span className="ml-auto flex items-center gap-2">
          <PhaseBadge phase={phase} />
          <button
            onClick={run}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
            title="Replay"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </span>
      </div>

      <div className="space-y-4 p-4">
        {/* user */}
        <div className="flex justify-end">
          <div className="flex max-w-[80%] items-start gap-2">
            <div className="rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm text-white">
              {QUESTION}
            </div>
            <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-500/30">
              <User className="h-3.5 w-3.5 text-brand-200" />
            </span>
          </div>
        </div>

        {/* tool call */}
        <AnimatePresence>
          {(phase === "tool" || phase === "streaming" || phase === "done") && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="flex justify-start"
            >
              <div className="flex items-center gap-2 rounded-lg border border-accent-cyan/20 bg-cyan-500/[0.06] px-3 py-1.5 font-mono text-[11px] text-cyan-300">
                <Terminal className="h-3.5 w-3.5" />
                {TOOL_LINE}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* assistant */}
        <div className="flex justify-start">
          <div className="flex max-w-[88%] items-start gap-2">
            <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-500/20">
              <Bot className="h-3.5 w-3.5 text-brand-300" />
            </span>
            <div className="min-h-[2.5rem] rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm leading-relaxed text-slate-200">
              {phase === "thinking" || phase === "tool" ? (
                <span className="flex items-center gap-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {phase === "thinking" ? "Thinking…" : "Reading run results…"}
                </span>
              ) : (
                <MiniMarkdown text={typed} />
              )}
              {phase === "streaming" && (
                <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand-400" />
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
        <div className="flex-1 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-slate-500">
          Ask the scheduling expert…
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white">
          <Send className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const map: Record<Phase, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "text-slate-500" },
    thinking: { label: "spawning devin", cls: "text-amber-300" },
    tool: { label: "tool: exec", cls: "text-cyan-300" },
    streaming: { label: "SSE streaming", cls: "text-brand-300" },
    done: { label: "done", cls: "text-emerald-300" },
  };
  const s = map[phase];
  return (
    <span className={`font-mono text-[10px] uppercase tracking-wider ${s.cls}`}>
      ● {s.label}
    </span>
  );
}

// Tiny markdown: **bold**, bullet lines.
function MiniMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      {text.split("\n").map((line, i) => {
        if (line.trim() === "") return <div key={i} className="h-1" />;
        const bullet = line.trimStart().startsWith("- ");
        const content = bullet ? line.trimStart().slice(2) : line;
        const parts = content.split(/(\*\*[^*]+\*\*)/g);
        const rendered = parts.map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j} className="font-semibold text-white">
              {p.slice(2, -2)}
            </strong>
          ) : (
            <span key={j}>{p}</span>
          )
        );
        return bullet ? (
          <div key={i} className="flex gap-2">
            <span className="text-brand-400">•</span>
            <span>{rendered}</span>
          </div>
        ) : (
          <p key={i}>{rendered}</p>
        );
      })}
    </div>
  );
}

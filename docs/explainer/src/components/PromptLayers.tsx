
import { useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Network, Database, ListChecks, MessageSquare } from "lucide-react";

type Layer = {
  id: string;
  fn: string;
  label: string;
  tone: string;
  border: string;
  icon: typeof BookOpen;
  always: boolean;
  detail: string;
  sample: string;
};

const LAYERS: Layer[] = [
  {
    id: "domain",
    fn: "DOMAIN_EXPERTISE",
    label: "Domain expertise",
    tone: "text-brand-200",
    border: "border-brand-500/50 bg-brand-500/[0.07]",
    icon: BookOpen,
    always: true,
    detail:
      "Static text that teaches the model the scheduling vocabulary so the user never has to re-explain the model: lead time / cycle time, bays, backward scheduling, demand explosion, unshippable units, and the cross-quarter window rule.",
    sample: `You are a finite-capacity production-scheduling expert…
- Lead time: days a unit occupies a bay from build start to ship.
- Bays: physical build positions; one bay holds one unit at a time.
- Backward scheduling: each unit scheduled back from its due date…`,
  },
  {
    id: "api",
    fn: "api_reference()",
    label: "API reference",
    tone: "text-cyan-200",
    border: "border-accent-cyan/50 bg-cyan-500/[0.07]",
    icon: Network,
    always: true,
    detail:
      "A live list of GET/POST/PUT endpoints (with the real base URL from HOST/PORT) so the agent can curl for data beyond the snapshot or run what-ifs — plus the safety rule: clone before mutating, never touch the active scenario unless asked.",
    sample: `## factoryplan API (http://127.0.0.1:8080)
You have an exec tool. Use curl when you need more data.
  GET  /api/scenarios/{id}/products   (lead times)
  POST /api/scenarios/{id}/run        (runs the scheduler)
For what-ifs: clone first, modify the clone, run, compare.`,
  },
  {
    id: "snapshot",
    fn: "format_scenario_context()",
    label: "Scenario snapshot (tiered)",
    tone: "text-amber-200",
    border: "border-accent-amber/50 bg-amber-500/[0.07]",
    icon: Database,
    always: true,
    detail:
      "A snapshot of the current scenario, generated from the DB in TWO tiers. Tier 1 (counts + last-run summary) is sent every turn. Tier 2 (full bay matrix, per-quarter lead times, demand by period) is sent ONLY on the first message — keeping follow-up prompts small and fast.",
    sample: `## Current scenario
- Factories: 2 (total 18 base bays)
- Products: 4 · Demand: 12 rows, 230 units
- Last run: 230 total, 212 on time, 18 unshippable (92% fill)
### Factories  (Tier 2 — first message only)
- Riverside: 10 bays, 2025 Q3: 12 bays …`,
  },
  {
    id: "rules",
    fn: "response_instructions()",
    label: "Response rules",
    tone: "text-emerald-200",
    border: "border-accent-emerald/50 bg-emerald-500/[0.07]",
    icon: ListChecks,
    always: true,
    detail:
      "Behavior + formatting contract: lead with the conclusion, interpret data (don't dump raw JSON), use clean Markdown, be concise, and — critically — print ONLY the final answer to stdout, because stdout IS the SSE stream.",
    sample: `## How to respond
1. Lead with the conclusion, then the reasoning.
2. Interpret data — cite names, numbers, dates, %.
6. Print ONLY your final answer to stdout. Nothing else.`,
  },
  {
    id: "history",
    fn: "format_devin_input()",
    label: "History + current message",
    tone: "text-slate-200",
    border: "border-white/30 bg-white/[0.05]",
    icon: MessageSquare,
    always: true,
    detail:
      "Appended last: the prior turns (role-labelled) and the current user message, so multi-turn context is preserved across the stateless CLI invocation.",
    sample: `## Conversation so far
### User
Run the scheduler and summarize.
### You (assistant)
92% fill; 18 unshippable, all in Q3…
## Current user message
Why are some units unshippable in Q3?`,
  },
];

export function PromptLayers() {
  const [active, setActive] = useState(LAYERS[0].id);
  const layer = LAYERS.find((l) => l.id === active)!;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2.5">
        {LAYERS.map((l, idx) => {
          const Icon = l.icon;
          const isActive = l.id === active;
          return (
            <motion.button
              key={l.id}
              onClick={() => setActive(l.id)}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.06 }}
              className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                isActive ? l.border : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5">
                <Icon className={`h-4 w-4 ${isActive ? l.tone : "text-slate-400"}`} />
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${isActive ? "text-white" : "text-slate-300"}`}>
                  {l.label}
                </span>
                <code className="block truncate text-[11px] text-slate-500">{l.fn}</code>
              </span>
              <span
                className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                  l.always ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
                }`}
              >
                every turn
              </span>
            </motion.button>
          );
        })}
      </div>

      <motion.div
        key={layer.id}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className={`glass flex flex-col p-5 ${layer.border}`}
      >
        <h4 className={`text-lg font-semibold ${layer.tone}`}>{layer.label}</h4>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{layer.detail}</p>
        <p className="mt-4 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          What it looks like in the prompt
        </p>
        <pre className="overflow-x-auto rounded-lg border border-white/10 bg-ink-950/80 p-3 font-mono text-[11px] leading-relaxed text-slate-400">
          <code>{layer.sample}</code>
        </pre>
      </motion.div>
    </div>
  );
}

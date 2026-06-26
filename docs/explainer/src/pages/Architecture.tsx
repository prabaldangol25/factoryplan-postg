import { PageHeader, Section, Card, Callout, Reveal, Stat } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";
import { ArchitectureDiagram } from "@/components/diagrams/ArchitectureDiagram";

export function Architecture() {
  return (
    <>
      <PageHeader
        eyebrow="Architecture"
        title="The moving parts, and how they connect"
        intro="Five components, four endpoints, two tables, one subprocess. Watch the data flow between them, then see exactly which file owns each responsibility."
      />

      <Section kicker="Live map" title="Data flow between components">
        <Reveal>
          <ArchitectureDiagram />
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-3 text-center text-xs text-slate-500">
            Packets show direction of data. Note devin talking <em>back</em> to the API — the
            agent is a client of the same app it lives in.
          </p>
        </Reveal>
      </Section>

      <Section kicker="At a glance" title="By the numbers">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Reveal><Stat value="4" label="HTTP endpoints" color="text-brand-300" /></Reveal>
          <Reveal delay={0.05}><Stat value="2" label="SQLite tables" color="text-accent-cyan" /></Reveal>
          <Reveal delay={0.1}><Stat value="180s" label="hard timeout" color="text-accent-amber" /></Reveal>
          <Reveal delay={0.15}><Stat value="1" label="subprocess / turn" color="text-accent-emerald" /></Reveal>
        </div>
      </Section>

      <Section kicker="Endpoints" title="The four routes">
        <Reveal>
          <Card>
            <CodeBlock
              lang="rust"
              file="backend/src/handlers/agent.rs"
              highlightLines={[2]}
              code={`pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(agent_chat)            // POST   /api/agent/chat            (SSE stream)
        .service(list_conversations)   // GET    /api/agent/conversations
        .service(get_messages)         // GET    /api/agent/conversations/{id}/messages
        .service(delete_conversation); // DELETE /api/agent/conversations/{id}
}`}
            />
          </Card>
        </Reveal>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            ["POST /api/agent/chat", "The only streaming route. Everything interesting happens here.", "text-brand-300"],
            ["GET …/conversations", "List threads for a scenario (sidebar dropdown).", "text-cyan-300"],
            ["GET …/{id}/messages", "Replay a thread's history after a turn.", "text-emerald-300"],
            ["DELETE …/{id}", "Cascade-deletes the thread + its messages.", "text-rose-300"],
          ].map(([route, desc, toneCls]) => (
            <div
              key={route as string}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
            >
              <code className={`text-sm font-semibold ${toneCls}`}>{route}</code>
              <p className="mt-1 text-sm text-slate-400">{desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section kicker="Responsibilities" title="Who owns what">
        <div className="space-y-3">
          {[
            {
              file: "frontend/src/components/AgentChat.tsx",
              role: "UI + optimistic state",
              detail: "Conversation switcher, message bubbles, markdown rendering, suggestion chips, abort-on-navigate.",
            },
            {
              file: "frontend/src/api/index.ts",
              role: "SSE client",
              detail: "sendAgentMessage() parses the data:/[CONV]/[DONE]/[ERROR] protocol from a ReadableStream.",
            },
            {
              file: "backend/src/handlers/agent.rs",
              role: "Orchestration",
              detail: "Validation, conversation bookkeeping, prompt building, subprocess lifecycle, SSE encoding, persistence.",
            },
            {
              file: "backend/migrations/0003_agent.sql",
              role: "Persistence schema",
              detail: "agent_conversation + agent_message, scoped per scenario with ON DELETE CASCADE.",
            },
          ].map((r, i) => (
            <Reveal key={r.file} delay={i * 0.06}>
              <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center sm:gap-4">
                <code className="shrink-0 text-xs text-brand-300 sm:w-72">{r.file}</code>
                <div>
                  <span className="text-sm font-medium text-white">{r.role}</span>
                  <p className="text-sm text-slate-400">{r.detail}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Callout kind="warn" title="The interesting subtlety">
          The <code>devin</code> subprocess calls the factoryplan API back over HTTP via{" "}
          <code>curl</code>. So the agent is simultaneously <em>inside</em> the app (spawned by
          it) and a <em>client</em> of it. That&apos;s what lets it fetch exact per-unit
          assignments or run a what-if on a cloned scenario — capabilities the static prompt
          snapshot alone could never provide.
        </Callout>
      </Section>
    </>
  );
}

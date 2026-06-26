import { PageHeader, Section, Card, Callout, Reveal, Pill } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";
import { Terminal, Radio, Layers, Database } from "lucide-react";

export function FirstPrinciples() {
  return (
    <>
      <PageHeader
        eyebrow="First Principles"
        title="Four raw ideas. That's the whole feature."
        intro="Forget 'AI' for a moment. The Ask Agent is just four well-known building blocks composed together. Understand these and the rest of the codebase reads like plain orchestration."
      />

      <Section kicker="Idea 1" title="An LLM agent is just a program you run">
        <Reveal>
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/15">
                <Terminal className="h-5 w-5 text-accent-emerald" />
              </span>
              <Pill tone="emerald">subprocess</Pill>
            </div>
            <p className="text-slate-300">
              The intelligence lives in the <code>devin</code> CLI. To your backend it is no
              different from <code>ls</code> or <code>git</code>: you start it, optionally give it
              input, and read what it prints. &quot;Asking the agent&quot; literally means{" "}
              <strong className="text-white">running a command and capturing stdout</strong>.
            </p>
            <div className="mt-4">
              <CodeBlock
                lang="bash"
                file="the core of it, conceptually"
                code={`# 1. write the prompt to a file
echo "<system prompt + history + question>" > prompt.txt

# 2. run the agent in print (non-interactive) mode
devin -p --prompt-file prompt.txt --permission-mode dangerous

# 3. whatever it prints to stdout *is* the answer`}
              />
            </div>
          </Card>
        </Reveal>
        <div className="mt-4">
          <Callout kind="info" title="Why a subprocess and not an HTTP SDK?">
            It decouples the app from any specific model/provider, keeps secrets out of the
            web server, and lets the agent use its own tools (like running <code>curl</code>).
            The trade-off is process management — which is most of the careful code in{" "}
            <code>agent.rs</code>.
          </Callout>
        </div>
      </Section>

      <Section kicker="Idea 2" title="A model is only as smart as its prompt">
        <Reveal>
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15">
                <Layers className="h-5 w-5 text-accent-amber" />
              </span>
              <Pill tone="amber">grounding</Pill>
            </div>
            <p className="text-slate-300">
              A raw model knows English, not <em>your</em> factory. So before running it, the
              backend prepends everything it needs to be useful: the rules of the domain, a
              snapshot of the current scenario, and instructions on how to answer. This is called{" "}
              <strong className="text-white">grounding</strong> — replacing &quot;guessing&quot;
              with &quot;reading the actual data.&quot;
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-4">
                <p className="text-sm font-semibold text-rose-300">Without grounding</p>
                <p className="mt-1 text-sm text-slate-400">
                  Generic advice. Hallucinated bay counts. &quot;It depends.&quot;
                </p>
              </div>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-4">
                <p className="text-sm font-semibold text-emerald-300">With grounding</p>
                <p className="mt-1 text-sm text-slate-400">
                  Cites Riverside&apos;s 10 bays, Q3&apos;s 18-unit peak, 92% fill.
                </p>
              </div>
            </div>
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Idea 3" title="Don't make the user wait for the whole answer">
        <Reveal>
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15">
                <Radio className="h-5 w-5 text-brand-300" />
              </span>
              <Pill tone="brand">streaming · SSE</Pill>
            </div>
            <p className="text-slate-300">
              Agents are slow — answers take seconds. Instead of buffering the full response,
              the backend forwards each line the moment it appears, using{" "}
              <strong className="text-white">Server-Sent Events</strong> (SSE): a one-way HTTP
              stream where the server keeps the connection open and writes{" "}
              <code>data:</code> lines over time.
            </p>
            <div className="mt-4">
              <CodeBlock
                lang="text"
                file="what travels down the wire"
                code={`data: [CONV] conv_8f2a       <- control: pin the conversation id
data: **Q3 is bay-bound.**   <- a chunk of the answer
data: Across both factories  <- another chunk
data: [DONE]                 <- control: turn complete`}
              />
            </div>
            <p className="mt-3 text-sm text-slate-400">
              The browser reads this stream with <code>fetch()</code> +{" "}
              <code>ReadableStream</code> and appends each chunk live — that&apos;s the typewriter
              effect.
            </p>
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Idea 4" title="Memory is just rows in a table">
        <Reveal>
          <Card>
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-500/15">
                <Database className="h-5 w-5 text-accent-cyan" />
              </span>
              <Pill tone="cyan">persistence</Pill>
            </div>
            <p className="text-slate-300">
              The CLI is <strong className="text-white">stateless</strong> — every run starts
              fresh. To make a multi-turn conversation, the backend stores each message in
              SQLite and replays the history into the next prompt. &quot;Memory&quot; is nothing
              more exotic than a <code>SELECT … ORDER BY created_at</code>.
            </p>
            <div className="mt-4">
              <CodeBlock
                lang="sql"
                file="migrations/0003_agent.sql"
                code={`CREATE TABLE agent_conversation (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    title TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE agent_message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL, created_at TEXT NOT NULL
);`}
              />
            </div>
          </Card>
        </Reveal>
      </Section>

      <Section>
        <Callout kind="ok" title="Put them together">
          Run a program (1), feed it a grounded prompt (2), stream its output (3), and remember
          the exchange (4). Everything else in <code>agent.rs</code> is making those four steps{" "}
          <em>safe and robust</em> — timeouts, kill-on-disconnect, empty-output diagnostics, temp
          cleanup. Head to <strong>Architecture</strong> to see the parts wired together.
        </Callout>
      </Section>
    </>
  );
}

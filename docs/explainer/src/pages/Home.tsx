import { Link } from "react-router-dom";
import { ArrowRight, Cpu, Radio, Layers, ShieldQuestion } from "lucide-react";
import { ChatDemo } from "@/components/ChatDemo";
import { Reveal, Section, Card, Callout, Pill } from "@/components/ui";
import { NAV } from "@/lib/site";

export function Home() {
  return (
    <>
      {/* Hero */}
      <section className="mb-16">
        <Reveal>
          <span className="chip border-brand-500/30 bg-brand-500/10 text-brand-200">
            <Cpu className="h-3.5 w-3.5" /> factoryplan · Ask Agent
          </span>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-5 text-balance text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl">
            A chat assistant that{" "}
            <span className="bg-gradient-to-r from-brand-300 via-accent-cyan to-accent-emerald bg-clip-text text-transparent">
              actually understands
            </span>{" "}
            your factory schedule.
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
            The &quot;Ask Agent&quot; tab lets a planner ask plain-English questions and get
            expert, number-grounded answers. This site explains how it works{" "}
            <em className="text-slate-300">from first principles</em> — and how you&apos;d build
            something like it yourself.
          </p>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              to="/first-principles"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-brand-500"
            >
              Start from first principles <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/flow"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-5 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/5"
            >
              Watch one request flow
            </Link>
          </div>
        </Reveal>
      </section>

      {/* Live demo */}
      <Section kicker="See it move" title="One question, end to end">
        <Reveal>
          <ChatDemo />
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-3 text-center text-xs text-slate-500">
            A simulation of the real flow: spawn devin → it curls the API → tokens stream
            back over SSE. Hit replay ↺.
          </p>
        </Reveal>
      </Section>

      {/* The one-breath explanation */}
      <Section kicker="The whole idea in one breath" title="What is actually happening?">
        <Reveal>
          <Card>
            <p className="text-lg leading-relaxed text-slate-300">
              When you ask a question, the Rust backend writes a carefully built prompt to a
              file, <Pill tone="emerald">spawns the <code>devin</code> CLI</Pill> as a child
              process, and <Pill tone="brand">streams its output</Pill> back to your browser
              line-by-line. The prompt is{" "}
              <Pill tone="amber">grounded</Pill> with a live snapshot of your scenario, and the
              agent can <Pill tone="cyan">call the API back</Pill> with <code>curl</code> to dig
              deeper or run what-ifs.
            </p>
          </Card>
        </Reveal>
        <div className="mt-5">
          <Callout kind="idea" title="No LLM API key in this codebase">
            factoryplan never calls OpenAI/Anthropic directly. It delegates all the
            intelligence to the <code>devin</code> command-line agent. The app&apos;s job is{" "}
            <strong>orchestration</strong>: build a good prompt, run the process safely, stream
            the result, and remember the conversation.
          </Callout>
        </div>
      </Section>

      {/* Three pillars */}
      <Section kicker="Three things make it tick" title="The mental model">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: Cpu,
              t: "Agent as subprocess",
              d: "The LLM lives in a separate CLI process. The backend treats it like any other program: feed stdin, read stdout.",
            },
            {
              icon: Radio,
              t: "Streaming over SSE",
              d: "stdout lines are pushed to the browser as Server-Sent Events so the answer appears as it's generated.",
            },
            {
              icon: Layers,
              t: "Grounded prompt",
              d: "Static expertise + a live data snapshot + a callable API turn a generic model into a domain expert.",
            },
          ].map((p, i) => (
            <Reveal key={p.t} delay={i * 0.08}>
              <Card className="h-full">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5">
                  <p.icon className="h-5 w-5 text-slate-200" />
                </span>
                <h3 className="mt-4 font-semibold text-white">{p.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{p.d}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Jump-off */}
      <Section kicker="Where to next" title="Pick a thread to pull">
        <div className="grid gap-3 sm:grid-cols-2">
          {NAV.filter((n) => n.href !== "/").map((n, i) => (
            <Reveal key={n.href} delay={i * 0.05}>
              <Link
                to={n.href}
                className="group flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-brand-500/40 hover:bg-brand-500/[0.05]"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5">
                  <n.icon className="h-5 w-5 text-brand-300" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-white">{n.label}</span>
                  <span className="block text-sm text-slate-400">{n.blurb}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-1 group-hover:text-brand-300" />
              </Link>
            </Reveal>
          ))}
        </div>
        <div className="mt-6">
          <Callout kind="info">
            <span className="inline-flex items-center gap-2">
              <ShieldQuestion className="h-4 w-4" /> New to agents? The{" "}
              <Link to="/first-principles" className="text-brand-300 underline">
                First Principles
              </Link>{" "}
              page assumes zero background.
            </span>
          </Callout>
        </div>
      </Section>
    </>
  );
}

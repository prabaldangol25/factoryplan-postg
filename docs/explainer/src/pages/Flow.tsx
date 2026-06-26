import { PageHeader, Section, Callout, Reveal } from "@/components/ui";
import { FlowStepper } from "@/components/FlowStepper";

export function Flow() {
  return (
    <>
      <PageHeader
        eyebrow="Request Flow"
        title="One chat turn, step by step"
        intro="Click through the eight stages of a single message — from the browser's optimistic bubble to the persisted assistant reply. Each step shows the real code that runs."
      />

      <Section kicker="Interactive" title="Walk the lifecycle">
        <Reveal>
          <FlowStepper />
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-3 text-center text-xs text-slate-500">
            Use the dots, or Prev / Next. Color = which side of the system owns the step.
          </p>
        </Reveal>
      </Section>

      <Section kicker="Robustness" title="What can go wrong — and the guardrails">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["Agent runs forever", "180s hard deadline (DEVIN_TIMEOUT_SECS); the child is killed and [ERROR] timed out is streamed."],
            ["User closes the tab", "tx.send fails -> child.start_kill() -> temp file removed. No orphan processes."],
            ["stderr pipe fills up", "stderr is drained on a separate tokio task so the child never blocks on a full pipe."],
            ["Agent prints nothing", "stderr / non-zero exit is surfaced as a useful [ERROR] instead of an empty bubble."],
            ["devin not installed", "Spawn error -> friendly [ERROR]: 'Is the devin CLI installed and on PATH?'"],
            ["Crash leaves temp files", "cleanup_temp_files() sweeps stale factoryplan_agent_input_* files at startup."],
          ].map(([t, d], i) => (
            <Reveal key={t} delay={i * 0.05}>
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-sm font-semibold text-white">{t}</p>
                <p className="mt-1 text-sm text-slate-400">{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Callout kind="idea" title="Why fetch() and not EventSource?">
          The browser&apos;s native <code>EventSource</code> only does <code>GET</code> and
          can&apos;t send a JSON body. This turn needs a <code>POST</code> with the message +
          scenario, so the client uses <code>fetch()</code> + <code>ReadableStream</code> and
          parses the SSE frames by hand (splitting on the blank-line separator).
        </Callout>
      </Section>
    </>
  );
}

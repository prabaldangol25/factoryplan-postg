import { PageHeader, Section, Card, Callout, Reveal } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";
import { PromptLayers } from "@/components/PromptLayers";
import { TieringChart } from "@/components/charts/TieringChart";

export function Context() {
  return (
    <>
      <PageHeader
        eyebrow="Context & Prompt"
        title="Exactly what the agent 'sees'"
        intro="When you hit send, the backend assembles a layered prompt. This is the single most important thing to understand — it's what turns a generic model into a factory-scheduling expert."
      />

      <Section kicker="The assembly" title="build_system_prompt(), in order">
        <Reveal>
          <Card>
            <CodeBlock
              lang="rust"
              file="backend/src/handlers/agent.rs"
              code={`async fn build_system_prompt(pool, scenario, include_details) -> AppResult<String> {
    let mut p = String::new();
    p.push_str(DOMAIN_EXPERTISE);                                        // 1. who you are
    p.push_str(&api_reference());                                        // 2. tools you can call
    p.push_str(&format_scenario_context(pool, scenario, include_details).await?); // 3. the data
    p.push_str(&response_instructions());                                // 4. how to answer
    Ok(p)
}
// …then format_devin_input() appends 5. history + the current message.`}
              highlightLines={[3, 4, 5, 6]}
            />
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Explore" title="The five layers — click to inspect">
        <PromptLayers />
      </Section>

      <Section kicker="The clever bit" title="Two-tier context to stay fast & cheap">
        <Reveal>
          <p className="mb-5 max-w-2xl text-slate-400">
            Re-sending the entire scenario on every turn is wasteful. So the heavy detail block
            (per-factory bay matrix, per-product lead times, demand by period) is gated on{" "}
            <code>history.is_empty()</code> — it&apos;s sent on the{" "}
            <strong className="text-white">first message only</strong>. Every later turn carries
            just the light Tier-1 summary.
          </p>
        </Reveal>
        <Reveal>
          <TieringChart />
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mt-5">
            <Card>
              <CodeBlock
                lang="rust"
                file="the gate, in agent_chat()"
                code={`// history.is_empty() is true only on the very first turn of a conversation.
let system_prompt =
    build_system_prompt(pool.get_ref(), &scenario, history.is_empty()).await?;

// inside format_scenario_context():
if include_details {
    s.push_str(&format_scenario_details(pool, scenario_id).await?); // Tier 2
}`}
                highlightLines={[6, 7, 8]}
              />
            </Card>
          </div>
        </Reveal>
      </Section>

      <Section kicker="Beyond the snapshot" title="The agent isn't limited to what it's given">
        <Reveal>
          <Callout kind="idea" title="The snapshot is a starting point, not a cage">
            The prompt includes an <strong>API reference</strong>, so when the snapshot
            isn&apos;t enough the agent runs <code>curl</code> to fetch exact per-unit
            assignments, or even clones the scenario and runs the scheduler to test a what-if —
            then compares results. The static context bootstraps it; the callable API gives it
            reach.
          </Callout>
        </Reveal>
        <div className="mt-4">
          <Reveal>
            <Card>
              <CodeBlock
                lang="text"
                file="api_reference() — abridged"
                code={`## factoryplan API (http://127.0.0.1:8080)
You have an exec tool. Use curl when you need data beyond the snapshot.

Read:   GET  /api/scenarios/{id}/products   (per-quarter lead times)
        GET  /api/runs/{run_id}             (results + recommendations)
Write:  POST /api/scenarios/{id}/run        (runs the scheduler)
        POST /api/scenarios                 ({ name, clone_from })

For what-ifs: clone first, modify the clone, run, compare.
NEVER mutate the user's active scenario unless they explicitly ask.`}
              />
            </Card>
          </Reveal>
        </div>
      </Section>

      <Section>
        <Callout kind="ok" title="The takeaway">
          Context = <strong>static expertise</strong> (who you are) +{" "}
          <strong>a callable API</strong> (what you can do) + <strong>a live snapshot</strong>{" "}
          (what&apos;s true right now) + <strong>history</strong> (what we&apos;ve said). Tiering
          keeps it small; the API keeps it powerful.
        </Callout>
      </Section>
    </>
  );
}

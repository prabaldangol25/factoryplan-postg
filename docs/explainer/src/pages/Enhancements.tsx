import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { PageHeader, Section, Reveal, Pill } from "@/components/ui";
import { ImpactEffortChart } from "@/components/charts/ImpactEffortChart";
import { ENHANCEMENTS } from "@/lib/site";

const TONE: Record<string, "emerald" | "brand" | "cyan" | "amber" | "rose"> = {
  Transparency: "cyan",
  Integration: "amber",
  Safety: "emerald",
  Quality: "brand",
  UX: "rose",
};

export function Enhancements() {
  return (
    <>
      <PageHeader
        eyebrow="Advancements"
        title="Where this goes next"
        intro="The current feature is a solid v1. Here we double-click on six concrete upgrades — each gets its own deep-dive page with architecture, mock UI, code sketches, and trade-offs."
      />

      <Section kicker="Prioritize" title="Impact vs. effort">
        <Reveal>
          <ImpactEffortChart />
        </Reveal>
      </Section>

      <Section kicker="Deep dives" title="Six advancements">
        <div className="grid gap-4 sm:grid-cols-2">
          {ENHANCEMENTS.map((e, i) => (
            <Reveal key={e.slug} delay={i * 0.06}>
              <Link
                to={`/enhancements/${e.slug}`}
                className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-brand-500/40 hover:bg-brand-500/[0.04]"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Pill tone={TONE[e.tag]}>{e.tag}</Pill>
                  <span className="ml-auto font-mono text-[10px] text-slate-500">
                    impact: {e.impact} · effort: {e.effort}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-white">{e.title}</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-slate-400">
                  {e.oneLiner}
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-300">
                  Open deep dive
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </Section>
    </>
  );
}

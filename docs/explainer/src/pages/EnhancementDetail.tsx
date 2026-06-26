import { Link, useParams, Navigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { Section, Card, Reveal, Pill } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";
import { DemoBySlug } from "@/components/enhancements/Demos";
import { DETAILS } from "@/lib/enhancements-content";
import { ENHANCEMENTS } from "@/lib/site";

export function EnhancementDetail() {
  const { slug = "" } = useParams();
  const meta = ENHANCEMENTS.find((e) => e.slug === slug);
  const detail = DETAILS[slug];
  if (!meta || !detail) return <Navigate to="/enhancements" replace />;

  const idx = ENHANCEMENTS.findIndex((e) => e.slug === slug);
  const next = ENHANCEMENTS[(idx + 1) % ENHANCEMENTS.length];

  return (
    <>
      <Reveal>
        <Link
          to="/enhancements"
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> All advancements
        </Link>
      </Reveal>

      <header className="mb-12 mt-6">
        <Reveal>
          <div className="flex items-center gap-2">
            <Pill tone="brand">{meta.tag}</Pill>
            <span className="font-mono text-xs text-slate-500">
              impact: {meta.impact} · effort: {meta.effort}
            </span>
          </div>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-4 text-4xl font-bold tracking-tight text-white sm:text-5xl">
            {meta.title}
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-4 max-w-2xl text-lg text-slate-400">{meta.oneLiner}</p>
        </Reveal>
      </header>

      <Section kicker="The problem" title="Why this matters">
        <Reveal>
          <Card>
            <p className="leading-relaxed text-slate-300">{detail.problem}</p>
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Mock-up" title="What it could feel like">
        <Reveal>
          <DemoBySlug slug={slug} />
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-3 text-center text-xs text-slate-500">
            Interactive mock — not wired to a backend, just illustrating the interaction.
          </p>
        </Reveal>
      </Section>

      <Section kicker="The approach" title="How you'd build it">
        <div className="space-y-3">
          {detail.approach.map((a, i) => (
            <Reveal key={a.title} delay={i * 0.06}>
              <div className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-sm font-semibold text-brand-300">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-white">{a.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-400">{a.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section kicker="Code sketch" title="The shape of the change">
        <Reveal>
          <Card>
            <CodeBlock lang={detail.code.lang} file={detail.code.file} code={detail.code.body} />
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Touch points" title="What you'd actually change">
        <Reveal>
          <Card>
            <ul className="space-y-2">
              {detail.changes.map((c) => (
                <li key={c} className="flex gap-2.5 text-sm text-slate-300">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                  {c}
                </li>
              ))}
            </ul>
          </Card>
        </Reveal>
      </Section>

      <Section kicker="Trade-offs" title="The honest cost/benefit">
        <div className="grid gap-4 sm:grid-cols-2">
          <Reveal>
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-5">
              <p className="mb-3 font-semibold text-emerald-300">Upside</p>
              <ul className="space-y-2">
                {detail.pros.map((p) => (
                  <li key={p} className="flex gap-2 text-sm text-slate-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {p}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.05] p-5">
              <p className="mb-3 font-semibold text-rose-300">Cost / risk</p>
              <ul className="space-y-2">
                {detail.cons.map((c) => (
                  <li key={c} className="flex gap-2 text-sm text-slate-300">
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" /> {c}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section>
        <Link
          to={`/enhancements/${next.slug}`}
          className="group flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-brand-500/40 hover:bg-brand-500/[0.04]"
        >
          <span>
            <span className="text-xs text-slate-500">Next advancement</span>
            <span className="block text-lg font-semibold text-white">{next.title}</span>
          </span>
          <ArrowRight className="h-5 w-5 text-slate-500 transition group-hover:translate-x-1 group-hover:text-brand-300" />
        </Link>
      </Section>
    </>
  );
}

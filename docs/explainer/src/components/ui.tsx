
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { Info, AlertTriangle, Lightbulb, CheckCircle2 } from "lucide-react";

export function Reveal({
  children,
  delay = 0,
  y = 16,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: ReactNode;
  intro: ReactNode;
}) {
  return (
    <header className="mb-12">
      <Reveal>
        <span className="chip border-brand-500/30 bg-brand-500/10 text-brand-200">
          {eyebrow}
        </span>
      </Reveal>
      <Reveal delay={0.05}>
        <h1 className="mt-4 max-w-3xl text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {title}
        </h1>
      </Reveal>
      <Reveal delay={0.1}>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-400">{intro}</p>
      </Reveal>
    </header>
  );
}

export function Section({
  title,
  kicker,
  children,
}: {
  title?: string;
  kicker?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-16">
      {kicker && (
        <Reveal>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">
            {kicker}
          </p>
        </Reveal>
      )}
      {title && (
        <Reveal>
          <h2 className="mb-6 text-2xl font-bold tracking-tight text-white">{title}</h2>
        </Reveal>
      )}
      {children}
    </section>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`glass p-6 ${className}`}>{children}</div>;
}

const CALLOUT_STYLES = {
  info: { icon: Info, ring: "border-brand-500/30 bg-brand-500/[0.06]", color: "text-brand-300" },
  warn: { icon: AlertTriangle, ring: "border-accent-amber/30 bg-amber-500/[0.06]", color: "text-accent-amber" },
  idea: { icon: Lightbulb, ring: "border-accent-cyan/30 bg-cyan-500/[0.06]", color: "text-accent-cyan" },
  ok: { icon: CheckCircle2, ring: "border-accent-emerald/30 bg-emerald-500/[0.06]", color: "text-accent-emerald" },
} as const;

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUT_STYLES;
  title?: string;
  children: ReactNode;
}) {
  const s = CALLOUT_STYLES[kind];
  const Icon = s.icon;
  return (
    <div className={`flex gap-3 rounded-xl border p-4 ${s.ring}`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.color}`} />
      <div className="text-sm leading-relaxed text-slate-300">
        {title && <p className={`mb-1 font-semibold ${s.color}`}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function Stat({ value, label, color = "text-white" }: { value: string; label: string; color?: string }) {
  return (
    <div className="glass px-5 py-4">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-400">{label}</div>
    </div>
  );
}

export function Pill({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "cyan" | "emerald" | "amber" | "rose" | "slate" }) {
  const tones: Record<string, string> = {
    brand: "border-brand-500/40 bg-brand-500/10 text-brand-200",
    cyan: "border-accent-cyan/40 bg-cyan-500/10 text-cyan-200",
    emerald: "border-accent-emerald/40 bg-emerald-500/10 text-emerald-200",
    amber: "border-accent-amber/40 bg-amber-500/10 text-amber-200",
    rose: "border-accent-rose/40 bg-rose-500/10 text-rose-200",
    slate: "border-white/15 bg-white/5 text-slate-300",
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

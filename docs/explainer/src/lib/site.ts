import {
  Home,
  Network,
  Workflow,
  Layers,
  Atom,
  Rocket,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
};

export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: Home, blurb: "What the Ask Agent is, from zero." },
  { href: "/first-principles", label: "First Principles", icon: Atom, blurb: "The 4 raw ideas it is built from." },
  { href: "/architecture", label: "Architecture", icon: Network, blurb: "The moving parts and how they connect." },
  { href: "/flow", label: "Request Flow", icon: Workflow, blurb: "Step through one chat turn, live." },
  { href: "/context", label: "Context & Prompt", icon: Layers, blurb: "Exactly what the agent 'sees'." },
  { href: "/enhancements", label: "Advancements", icon: Rocket, blurb: "Deep dives on what to build next." },
];

export type Enhancement = {
  slug: string;
  title: string;
  tag: string;
  oneLiner: string;
  impact: "High" | "Medium" | "Foundational";
  effort: "S" | "M" | "L";
};

export const ENHANCEMENTS: Enhancement[] = [
  {
    slug: "tool-trace",
    title: "Tool-Call Trace Panel",
    tag: "Transparency",
    oneLiner: "Show every curl/exec the agent ran so users can audit the answer.",
    impact: "High",
    effort: "M",
  },
  {
    slug: "structured-results",
    title: "Structured Action Results",
    tag: "Integration",
    oneLiner: "Render a real Gantt chart inline when the agent runs a scenario.",
    impact: "High",
    effort: "M",
  },
  {
    slug: "apply-diff",
    title: "Propose-and-Apply Diffs",
    tag: "Safety",
    oneLiner: "Agent proposes a change; the user approves it with one click.",
    impact: "High",
    effort: "L",
  },
  {
    slug: "read-only-mode",
    title: "Read-Only / Confirmation Gate",
    tag: "Safety",
    oneLiner: "Drop dangerous permissions; gate every write behind approval.",
    impact: "Foundational",
    effort: "S",
  },
  {
    slug: "context-memory",
    title: "Smart Context & Memory",
    tag: "Quality",
    oneLiner: "Re-inject changed data and summarize old turns to fight drift.",
    impact: "Medium",
    effort: "M",
  },
  {
    slug: "token-streaming",
    title: "Token-Level Streaming + Stop",
    tag: "UX",
    oneLiner: "Smooth per-token typing, status events, and a Stop button.",
    impact: "Medium",
    effort: "S",
  },
];

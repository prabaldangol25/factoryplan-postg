import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { NAV } from "@/lib/site";

export function Nav() {
  const pathname = useLocation().pathname;
  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r border-white/10 bg-ink-900/60 px-4 py-6 backdrop-blur lg:flex">
      <Link to="/" className="mb-8 flex items-center gap-3 px-2">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-cyan shadow-lg shadow-brand-500/30">
          <Bot className="h-5 w-5 text-white" />
        </span>
        <span>
          <span className="block text-sm font-semibold text-white">Ask Agent</span>
          <span className="block text-xs text-slate-400">factoryplan, explained</span>
        </span>
      </Link>

      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              to={item.href}
              className="group relative rounded-xl px-3 py-2.5 transition"
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-xl border border-brand-500/40 bg-brand-500/10"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span className="relative flex items-start gap-3">
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    active ? "text-brand-300" : "text-slate-400 group-hover:text-slate-200"
                  }`}
                />
                <span>
                  <span
                    className={`block text-sm font-medium ${
                      active ? "text-white" : "text-slate-300 group-hover:text-white"
                    }`}
                  >
                    {item.label}
                  </span>
                  <span className="block text-[11px] leading-tight text-slate-500">
                    {item.blurb}
                  </span>
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-xl border border-white/10 bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-500">
        Source of truth:
        <code className="mt-1 block text-slate-400">backend/src/handlers/agent.rs</code>
        <code className="block text-slate-400">frontend/src/components/AgentChat.tsx</code>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = useLocation().pathname;
  return (
    <div className="sticky top-0 z-40 flex gap-1 overflow-x-auto border-b border-white/10 bg-ink-900/80 px-3 py-2 backdrop-blur lg:hidden">
      {NAV.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
              active
                ? "bg-brand-500/20 text-brand-200"
                : "text-slate-400 hover:text-white"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
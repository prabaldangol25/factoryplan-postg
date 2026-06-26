
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
} from "recharts";

const NAIVE = [
  { turn: "T1", tokens: 2100 },
  { turn: "T2", tokens: 2100 },
  { turn: "T3", tokens: 2100 },
  { turn: "T4", tokens: 2100 },
  { turn: "T5", tokens: 2100 },
];

const TIERED = [
  { turn: "T1", tier1: 420, tier2: 1680 },
  { turn: "T2", tier1: 420, tier2: 0 },
  { turn: "T3", tier1: 420, tier2: 0 },
  { turn: "T4", tier1: 420, tier2: 0 },
  { turn: "T5", tier1: 420, tier2: 0 },
];

function tip(active?: boolean, payload?: any[]) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200 shadow-xl">
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-mono">{p.value} tok</span>
        </div>
      ))}
    </div>
  );
}

export function TieringChart() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="glass p-4">
        <p className="mb-3 text-sm font-medium text-rose-300">Naïve: full snapshot every turn</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={NAIVE} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <XAxis dataKey="turn" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip content={({ active, payload }) => tip(active, payload as any[])} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar dataKey="tokens" name="prompt" radius={[6, 6, 0, 0]}>
              {NAIVE.map((_, i) => (
                <Cell key={i} fill="#fb7185" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-2 text-center font-mono text-xs text-rose-300/80">≈ 10,500 tokens total</p>
      </div>

      <div className="glass p-4">
        <p className="mb-3 text-sm font-medium text-emerald-300">Tiered: heavy detail only on T1</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={TIERED} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <XAxis dataKey="turn" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} domain={[0, 2100]} />
            <Tooltip content={({ active, payload }) => tip(active, payload as any[])} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="tier1" stackId="a" name="Tier 1 (always)" fill="#34d399" radius={[0, 0, 0, 0]} />
            <Bar dataKey="tier2" stackId="a" name="Tier 2 (first only)" fill="#fbbf24" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-2 text-center font-mono text-xs text-emerald-300/80">≈ 3,360 tokens total — 68% smaller</p>
      </div>
    </div>
  );
}


import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  Cell,
} from "recharts";

// x = effort (1 S .. 3 L), y = impact (1..3)
const DATA = [
  { name: "Read-only / gate", x: 1, y: 3, slug: "read-only-mode", color: "#34d399" },
  { name: "Token streaming + Stop", x: 1, y: 2, slug: "token-streaming", color: "#818cf8" },
  { name: "Tool-trace panel", x: 2, y: 3, slug: "tool-trace", color: "#22d3ee" },
  { name: "Structured results", x: 2, y: 3.05, slug: "structured-results", color: "#fbbf24" },
  { name: "Smart context", x: 2, y: 2, slug: "context-memory", color: "#a5b4fc" },
  { name: "Propose-and-apply", x: 3, y: 3, slug: "apply-diff", color: "#fb7185" },
];

export function ImpactEffortChart() {
  return (
    <div className="glass p-4">
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 16, right: 16, bottom: 28, left: 8 }}>
          <ReferenceArea x1={0.5} x2={2} y1={2.5} y2={3.5} fill="#34d399" fillOpacity={0.05} />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0.5, 3.5]}
            ticks={[1, 2, 3]}
            tickFormatter={(v) => ({ 1: "Small", 2: "Medium", 3: "Large" }[v as number] ?? "")}
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            axisLine={{ stroke: "#1e293b" }}
            tickLine={false}
            label={{ value: "Effort →", position: "bottom", fill: "#64748b", fontSize: 12 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0.5, 3.5]}
            ticks={[1, 2, 3]}
            tickFormatter={(v) => ({ 1: "Low", 2: "Med", 3: "High" }[v as number] ?? "")}
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            axisLine={{ stroke: "#1e293b" }}
            tickLine={false}
            label={{ value: "Impact →", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 12 }}
          />
          <ZAxis range={[220, 220]} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3", stroke: "#334155" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              return (
                <div className="rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200 shadow-xl">
                  {d.name}
                </div>
              );
            }}
          />
          <Scatter data={DATA}>
            {DATA.map((d) => (
              <Cell key={d.slug} fill={d.color} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-slate-500">
        Top-left = quick wins. The shaded zone is the &quot;do these first&quot; quadrant.
      </p>
    </div>
  );
}

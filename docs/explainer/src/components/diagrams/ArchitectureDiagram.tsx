
import { motion } from "framer-motion";

type Node = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  tone: string;
};

const NODES: Node[] = [
  { id: "browser", x: 20, y: 40, w: 200, h: 90, title: "Browser (React)", sub: "AgentChat.tsx", tone: "#818cf8" },
  { id: "backend", x: 300, y: 40, w: 220, h: 90, title: "actix-web backend", sub: "handlers/agent.rs", tone: "#22d3ee" },
  { id: "devin", x: 300, y: 200, w: 220, h: 80, title: "devin CLI (subprocess)", sub: "-p --prompt-file", tone: "#34d399" },
  { id: "db", x: 600, y: 40, w: 180, h: 90, title: "SQLite", sub: "conversation + message", tone: "#fbbf24" },
  { id: "api", x: 600, y: 200, w: 180, h: 80, title: "factoryplan API", sub: "curl callbacks", tone: "#fb7185" },
];

type Edge = { from: string; to: string; label: string; dir?: "down" };

const EDGES: Edge[] = [
  { from: "browser", to: "backend", label: "POST /api/agent/chat" },
  { from: "backend", to: "db", label: "history / persist" },
  { from: "backend", to: "devin", label: "spawn + prompt" },
  { from: "devin", to: "api", label: "curl exec tool" },
];

function center(n: Node) {
  return { cx: n.x + n.w / 2, cy: n.y + n.h / 2 };
}

function edgePath(a: Node, b: Node) {
  const ca = center(a);
  const cb = center(b);
  return { x1: ca.cx, y1: ca.cy, x2: cb.cx, y2: cb.cy };
}

export function ArchitectureDiagram() {
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  return (
    <div className="glass overflow-hidden p-4">
      <svg viewBox="0 0 800 320" className="w-full">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
          </marker>
        </defs>

        {/* edges */}
        {EDGES.map((e, i) => {
          const p = edgePath(byId[e.from], byId[e.to]);
          const mx = (p.x1 + p.x2) / 2;
          const my = (p.y1 + p.y2) / 2;
          return (
            <g key={i}>
              <line
                x1={p.x1}
                y1={p.y1}
                x2={p.x2}
                y2={p.y2}
                stroke="#334155"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              {/* flowing packet */}
              <motion.circle
                r={3.5}
                fill={byId[e.to].tone}
                initial={{ cx: p.x1, cy: p.y1, opacity: 0 }}
                animate={{
                  cx: [p.x1, p.x2],
                  cy: [p.y1, p.y2],
                  opacity: [0, 1, 1, 0],
                }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  delay: i * 0.45,
                  ease: "easeInOut",
                }}
              />
              <rect
                x={mx - e.label.length * 3 - 6}
                y={my - 9}
                width={e.label.length * 6 + 12}
                height={16}
                rx={4}
                fill="#0b1120"
                opacity={0.85}
              />
              <text x={mx} y={my + 3} textAnchor="middle" className="fill-slate-400" fontSize={9} fontFamily="monospace">
                {e.label}
              </text>
            </g>
          );
        })}

        {/* SSE return path (backend -> browser) */}
        <motion.circle
          r={3.5}
          fill="#a5b4fc"
          initial={{ opacity: 0 }}
          animate={{
            cx: [center(byId.backend).cx, center(byId.browser).cx],
            cy: [center(byId.backend).cy + 18, center(byId.browser).cy + 18],
            opacity: [0, 1, 1, 0],
          }}
          transition={{ duration: 1.6, repeat: Infinity, delay: 0.9, ease: "easeInOut" }}
        />
        <text x={260} y={108} textAnchor="middle" className="fill-brand-300" fontSize={9} fontFamily="monospace">
          SSE: data: …
        </text>

        {/* nodes */}
        {NODES.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={12}
              fill="#0f172a"
              stroke={n.tone}
              strokeOpacity={0.5}
              strokeWidth={1.5}
            />
            <rect x={n.x} y={n.y} width={4} height={n.h} rx={2} fill={n.tone} />
            <text x={n.x + 16} y={n.y + 32} className="fill-white" fontSize={14} fontWeight={600}>
              {n.title}
            </text>
            <text x={n.x + 16} y={n.y + 52} className="fill-slate-400" fontSize={11} fontFamily="monospace">
              {n.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

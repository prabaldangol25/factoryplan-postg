# Ask Agent — Interactive Explainer

A small Vite + React + Tailwind site that explains the **Ask Agent** feature of
factoryplan from first principles, with animated diagrams, an interactive request-flow
stepper, a layered-prompt explorer, charts, and clickable mock-ups of proposed
advancements.

It is a companion to [`../ASK_AGENT_FEATURE.md`](../ASK_AGENT_FEATURE.md) — the markdown
doc is the reference; this is the guided, visual tour.

## Run it

```bash
cd docs/explainer
npm install
npm run dev      # http://localhost:5180
```

Production build / preview:

```bash
npm run build    # outputs to dist/  (~7s)
npm run preview
```

## Stack

- **Vite + React 18 + TypeScript** — same family as the main `frontend/` app.
- **react-router-dom** — client-side routing (SPA).
- **Tailwind CSS** — styling.
- **framer-motion** — animations / transitions.
- **recharts** — the tiering, impact/effort, and chart visuals.
- **lucide-react** — icons.

> This was originally scaffolded in Next.js, but `next build` repeatedly hung on Windows
> due to `.next` / SWC binary file-locking. Vite builds the same app in seconds with no
> server/client-boundary friction, so the project was ported.

## Structure

```
src/
  main.tsx                  # entry + BrowserRouter
  App.tsx                   # layout + routes
  globals.css               # Tailwind + theme tokens
  lib/
    site.ts                 # nav config + enhancement metadata
    enhancements-content.ts # deep-dive copy per advancement
  components/
    Nav.tsx                 # sidebar + mobile nav
    ui.tsx                  # Reveal, Section, Card, Callout, Stat, Pill, PageHeader
    CodeBlock.tsx           # lightweight syntax-highlighted code
    ChatDemo.tsx            # animated streaming-chat simulation
    FlowStepper.tsx         # interactive 8-step request lifecycle
    PromptLayers.tsx        # clickable layered-prompt explorer
    diagrams/ArchitectureDiagram.tsx   # animated SVG system map
    charts/TieringChart.tsx            # naive vs tiered prompt size
    charts/ImpactEffortChart.tsx       # advancement prioritization
    enhancements/Demos.tsx  # interactive mock-ups per advancement
  pages/
    Home.tsx FirstPrinciples.tsx Architecture.tsx
    Flow.tsx Context.tsx Enhancements.tsx EnhancementDetail.tsx
```

## Pages

| Route | What it covers |
|-------|----------------|
| `/` | Overview + animated end-to-end chat demo |
| `/first-principles` | The 4 raw ideas: subprocess, grounding, SSE streaming, persistence |
| `/architecture` | Animated component map, endpoints, file responsibilities |
| `/flow` | Interactive step-through of one chat turn + robustness guardrails |
| `/context` | The 5 prompt layers + two-tier context strategy |
| `/enhancements` | Impact/effort chart + six advancement deep-dives |
| `/enhancements/:slug` | Per-advancement: problem, mock UI, approach, code, trade-offs |

All content is grounded in the real source: `backend/src/handlers/agent.rs`,
`frontend/src/components/AgentChat.tsx`, `frontend/src/api/index.ts`, and
`backend/migrations/0003_agent.sql`.

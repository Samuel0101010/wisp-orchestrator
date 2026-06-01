import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, FolderOpen, Play, RefreshCw, Search } from 'lucide-react';
import { usePlanGoap, type GoapAction, type GoapPlanResponse } from '@/api/queries';
import { cn } from '@/lib/utils';

const EXAMPLE_INITIAL = '{}';
const EXAMPLE_GOAL = '{"hasReport": true}';
const EXAMPLE_ACTIONS: GoapAction[] = [
  { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
  {
    name: 'analyze',
    cost: 2,
    preconditions: { hasInfo: true },
    effects: { hasAnalysis: true },
  },
  {
    name: 'write-report',
    cost: 3,
    preconditions: { hasAnalysis: true },
    effects: { hasReport: true },
  },
];

const ICONS = ['plan', 'build', 'tests', 'qa', 'security', 'docs', 'package', 'sign'] as const;
type IconKind = (typeof ICONS)[number];

interface LaidNode {
  x: number;
  y: number;
  name: string;
  cost: number;
  pre: string;
  post: string;
  state: 'done' | 'live' | 'next';
  i: number;
  icon: IconKind;
}

interface Layout {
  nodes: LaidNode[];
  start: { x: number; y: number };
  goal: { x: number; y: number };
  isUShape: boolean;
  /** viewBox width — always 1100; carried here for symmetry with height. */
  viewBoxW: number;
  /**
   * viewBox height. Single-row layouts use a tall viewBox (~950) so the
   * SVG content's aspect ratio matches the typical canvas card (~1.16),
   * which makes the SVG fill the card vertically instead of leaving big
   * empty bands above/below the plan row.
   * U-shape layouts keep the canonical 540 height (design parity).
   */
  viewBoxH: number;
  /** Center y of the atmosphere ellipses (glows). Tracks the plan row. */
  ambientY: number;
}

function shortFlag(rec: Record<string, boolean> | undefined, fallback: string) {
  if (!rec) return fallback;
  const keys = Object.keys(rec);
  if (!keys.length) return fallback;
  const k = keys[0]!;
  const head = rec[k] ? k : `!${k}`;
  return keys.length > 1 ? `${head} +${keys.length - 1}` : head;
}

/**
 * Layout the plan inside the W×H viewBox. ≤5 actions render as a single
 * horizontal row (start ─ n1 ─ n2 ─ … ─ goal) inside a near-square viewBox
 * so the canvas card fills cleanly; ≥6 wrap into the canonical 5+3 U-shape
 * (Wisp design parity) inside the original 1100×540 viewBox.
 */
function layoutActions(actions: GoapAction[], doneCount: number, liveIndex: number): Layout {
  const W = 1100;
  const n = Math.min(actions.length, 8);
  const meta = (a: GoapAction, i: number) => ({
    name: a.name,
    cost: a.cost,
    pre: shortFlag(a.preconditions, '—'),
    post: shortFlag(a.effects, '—'),
    state: (i < doneCount ? 'done' : i === liveIndex ? 'live' : 'next') as 'done' | 'live' | 'next',
    i: i + 1,
    icon: ICONS[i % ICONS.length] as IconKind,
  });

  if (n === 0) {
    const H = 540;
    return {
      nodes: [],
      start: { x: 120, y: H / 2 },
      goal: { x: W - 120, y: H / 2 },
      isUShape: false,
      viewBoxW: W,
      viewBoxH: H,
      ambientY: H / 2,
    };
  }

  if (n <= 5) {
    // Single horizontal row. Keep the viewBox at 540 (matches U-shape height)
    // so the dot-grid spacing stays consistent. The route component clamps
    // the canvas card height for single-row layouts so the SVG content fills
    // the card without leaving 200+px of empty wallpaper above/below the
    // plan row.
    const H = 540;
    const cy = H / 2;
    const step = n > 1 ? Math.min(220, (W - 360) / (n - 1)) : 0;
    const totalSpan = step * (n - 1);
    const firstX = (W - totalSpan) / 2;
    const nodes: LaidNode[] = actions.slice(0, n).map((a, i) => ({
      x: firstX + i * step,
      y: cy,
      ...meta(a, i),
    }));
    return {
      nodes,
      start: { x: Math.max(60, firstX - 180), y: cy },
      goal: { x: Math.min(W - 60, firstX + totalSpan + 180), y: cy },
      isUShape: false,
      viewBoxW: W,
      viewBoxH: H,
      ambientY: cy,
    };
  }

  // U-shape for 6–8 actions — design's canonical 5+3 split.
  const H = 540;
  const TOP_Y = 140;
  const BOT_Y = 400;
  const X_STEP = 180;
  const X0 = 200;
  const nodes: LaidNode[] = actions.slice(0, 8).map((a, i) => {
    const x = i < 5 ? X0 + i * X_STEP : X0 + (4 - (i - 5)) * X_STEP;
    const y = i < 5 ? TOP_Y : BOT_Y;
    return { x, y, ...meta(a, i) };
  });
  return {
    nodes,
    start: { x: 62, y: TOP_Y },
    goal: { x: 380, y: BOT_Y },
    isUShape: true,
    viewBoxW: W,
    viewBoxH: H,
    ambientY: TOP_Y,
  };
}

function StateLine({ k, v, on }: { k: string; v: string; on?: boolean }) {
  return (
    <div
      className="flex items-center justify-between rounded-md border px-2.5 py-1"
      style={{
        borderColor: 'var(--wisp-hairline)',
        background: on
          ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.08)'
          : 'var(--wisp-glass-inset)',
      }}
    >
      <span className="t-mono" style={{ fontSize: 11.5, color: 'var(--wisp-ink-2)' }}>
        {k}
      </span>
      <span
        className="t-mono"
        style={{
          fontSize: 11.5,
          color: on ? 'var(--mint)' : 'var(--wisp-ink-3)',
        }}
      >
        {v}
      </span>
    </div>
  );
}

function GoapIconGlyph({ kind, color }: { kind: IconKind; color: string }) {
  const p = {
    stroke: color,
    strokeWidth: 1.4,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'plan':
      return (
        <g {...p}>
          <rect x="1" y="1" width="10" height="11" rx="1.5" />
          <path d="M3 4h6M3 6h6M3 8h4" />
        </g>
      );
    case 'build':
      return (
        <g {...p}>
          <path d="M1 11l6-6l2.5-2.5L11 4l-6 6z" />
          <path d="M9 5L7 3" />
        </g>
      );
    case 'tests':
      return (
        <g {...p}>
          <circle cx="6" cy="6" r="4.2" />
          <path d="M4 6l1.6 1.6L8.5 4.5" />
        </g>
      );
    case 'qa':
      return (
        <g {...p}>
          <circle cx="5" cy="5" r="3.5" />
          <path d="M7.5 7.5l3 3" />
        </g>
      );
    case 'security':
      return (
        <g {...p}>
          <path d="M6 1L1.5 3v3.5c0 3 2 4.5 4.5 5.2c2.5-0.7 4.5-2.2 4.5-5.2V3z" />
        </g>
      );
    case 'docs':
      return (
        <g {...p}>
          <path d="M3 1h4.5L10 3.5V11H3zM7.5 1v2.5H10M4.5 5.5h4M4.5 7.5h4M4.5 9.5h2.5" />
        </g>
      );
    case 'package':
      return (
        <g {...p}>
          <path d="M1 4l5-2.7l5 2.7v5.4l-5 2.7l-5-2.7zM1 4l5 2.7M11 4l-5 2.7M6 6.7v6" />
        </g>
      );
    case 'sign':
      return (
        <g {...p}>
          <path d="M1 9c2 0 1.7-6 4-6c2 0 2 6 4 6c1 0 1.5-0.4 2-1M1 11h10" />
        </g>
      );
    default:
      return null;
  }
}

function GoapNodeCard({ node, hw, hh }: { node: LaidNode; hw: number; hh: number }) {
  const { t } = useTranslation();
  const w = hw * 2;
  const h = hh * 2;
  const live = node.state === 'live';
  const done = node.state === 'done';
  const tone = live ? 'coral' : done ? 'mint' : null;
  const bgFill = live
    ? 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.08)'
    : done
      ? 'var(--wisp-svg-card)'
      : 'var(--wisp-svg-card-soft)';
  const stroke = live
    ? 'var(--coral)'
    : done
      ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.45)'
      : 'var(--wisp-hairline-strong)';
  return (
    <g transform={`translate(${node.x - hw}, ${node.y - hh})`}>
      {live && (
        <rect
          x={-6}
          y={-6}
          width={w + 12}
          height={h + 12}
          rx={16}
          fill="hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.1)"
          stroke="none"
        />
      )}
      <rect
        width={w}
        height={h}
        rx={14}
        fill={bgFill}
        stroke={stroke}
        strokeWidth={live ? 1.8 : 1.2}
      />
      <rect x={1} y={1} width={w - 2} height={1} fill="var(--wisp-ink-5)" />
      <circle
        cx={20}
        cy={20}
        r={11}
        fill={
          tone
            ? `hsl(var(--${tone}-h) var(--${tone}-s) var(--${tone}-l) / 0.2)`
            : 'var(--wisp-ink-5)'
        }
        stroke={tone ? `var(--${tone})` : 'var(--wisp-hairline-strong)'}
        strokeWidth="1"
      />
      <g transform="translate(14, 14)">
        <GoapIconGlyph kind={node.icon} color={tone ? `var(--${tone})` : 'var(--wisp-ink-2)'} />
      </g>
      <circle
        cx={w - 14}
        cy={14}
        r={10}
        fill={done ? 'var(--mint)' : live ? 'var(--coral)' : 'var(--wisp-ink-5)'}
        stroke={done || live ? 'var(--wisp-svg-card)' : 'var(--wisp-hairline-strong)'}
        strokeWidth="2"
      />
      <text
        x={w - 14}
        y={18}
        textAnchor="middle"
        fontFamily="var(--f-mono)"
        fontSize="10"
        fontWeight="700"
        fill={done || live ? 'var(--wisp-bg-0)' : 'var(--wisp-ink-2)'}
      >
        {node.i}
      </text>
      <text
        x={36}
        y={18}
        fontFamily="var(--f-head)"
        fontSize="12"
        fontWeight="500"
        fill={live || done ? 'var(--wisp-ink)' : 'var(--wisp-ink-2)'}
      >
        {node.name}
      </text>
      <text x={36} y={32} fontFamily="var(--f-mono)" fontSize="10" fill="var(--wisp-ink-3)">
        {t('goap.node.cost', 'cost {{cost}}', { cost: node.cost })}
      </text>
      <line x1="14" y1="44" x2={w - 14} y2="44" stroke="var(--wisp-hairline)" />
      <g transform="translate(14, 52)">
        <rect
          x="0"
          y="0"
          width="56"
          height="20"
          rx="10"
          fill={
            done
              ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.15)'
              : 'var(--wisp-glass-inset)'
          }
          stroke={
            done ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.4)' : 'var(--wisp-hairline)'
          }
          strokeWidth="1"
        />
        <text
          x="28"
          y="14"
          textAnchor="middle"
          fontFamily="var(--f-mono)"
          fontSize="9.5"
          fontWeight="500"
          fill={done ? 'hsl(var(--mint-h) var(--mint-s) 78%)' : 'var(--wisp-ink-3)'}
        >
          {node.pre}
        </text>
        <path
          d="M 60 10 L 66 10 M 64 8 L 66 10 L 64 12"
          stroke="var(--wisp-ink-3)"
          strokeWidth="1.2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          x="72"
          y="0"
          width="56"
          height="20"
          rx="10"
          fill={
            done
              ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.15)'
              : live
                ? 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.15)'
                : 'var(--wisp-glass-inset)'
          }
          stroke={
            done
              ? 'hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.4)'
              : live
                ? 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.4)'
                : 'var(--wisp-hairline)'
          }
          strokeWidth="1"
        />
        <text
          x="100"
          y="14"
          textAnchor="middle"
          fontFamily="var(--f-mono)"
          fontSize="9.5"
          fontWeight="500"
          fill={
            done
              ? 'hsl(var(--mint-h) var(--mint-s) 78%)'
              : live
                ? 'hsl(var(--coral-h) var(--coral-s) 78%)'
                : 'var(--wisp-ink-3)'
          }
        >
          {node.post}
        </text>
      </g>
    </g>
  );
}

function GoapEdge({
  from,
  to,
  state,
  bend,
}: {
  from: [number, number];
  to: [number, number];
  state: 'done' | 'active' | 'next';
  bend?: 'right';
}) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  let path: string;
  if (bend === 'right') {
    const out = Math.max(x1, x2) + 60;
    path = `M ${x1} ${y1} C ${out} ${y1}, ${out} ${y2}, ${x2} ${y2}`;
  } else if (Math.abs(y1 - y2) < 1) {
    path = `M ${x1} ${y1} L ${x2} ${y2}`;
  } else {
    path = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
  }
  const done = state === 'done';
  const active = state === 'active';
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={done ? 'var(--mint)' : 'var(--wisp-ink-5)'}
        strokeOpacity={done ? 0.55 : 1}
        strokeWidth={done ? 2 : 1.4}
        strokeLinecap="round"
      />
      {active && (
        <>
          <path
            d={path}
            fill="none"
            stroke="var(--coral)"
            strokeWidth="2.2"
            opacity="0.4"
            strokeLinecap="round"
          />
          <path
            d={path}
            fill="none"
            stroke="var(--coral)"
            strokeWidth="2.2"
            strokeDasharray="6 10"
            strokeLinecap="round"
          />
        </>
      )}
    </g>
  );
}

function GoapCanvas({
  layout,
  startLabel,
  goalLabel,
  startSub,
  goalSub,
  summary,
  headlineState,
  overflowCount = 0,
  showProgress = true,
}: {
  layout: Layout;
  startLabel: string;
  goalLabel: string;
  startSub: string;
  goalSub: string;
  summary: { done: number; running: number; queued: number; cost: number; eta: string };
  headlineState: 'ready' | 'planned' | 'empty';
  overflowCount?: number;
  showProgress?: boolean;
}) {
  const { t } = useTranslation();
  const HW = 78;
  const HH = 43;
  const { nodes, start, goal: goalPos, isUShape, viewBoxW: W, viewBoxH: H, ambientY } = layout;

  // Build edges from the layout. Single-row layouts use straight horizontal
  // edges (start → n1 → … → goal); U-shapes use a curved bend between top
  // and bottom rows at index 4→5, then run right-to-left along the bottom.
  const edges: Array<{
    from: [number, number];
    to: [number, number];
    state: 'done' | 'active' | 'next';
    bend?: 'right';
  }> = [];
  if (nodes.length > 0) {
    edges.push({
      from: [start.x + 22, start.y],
      to: [nodes[0]!.x - HW, nodes[0]!.y],
      state: nodes[0]!.state === 'done' ? 'done' : nodes[0]!.state === 'live' ? 'active' : 'next',
    });
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i]!;
      const b = nodes[i + 1]!;
      const edgeState: 'done' | 'active' | 'next' =
        a.state === 'done' && (b.state === 'done' || b.state === 'live')
          ? 'done'
          : b.state === 'live'
            ? 'active'
            : 'next';
      // U-bend at index 4→5 (between top row and bottom row) — only when the
      // layout actually wraps to a second row.
      if (isUShape && i === 4) {
        edges.push({
          from: [a.x + HW, a.y],
          to: [b.x + HW, b.y],
          state: edgeState,
          bend: 'right',
        });
      } else if (isUShape && i >= 5) {
        // bottom row runs right-to-left
        edges.push({
          from: [a.x - HW, a.y],
          to: [b.x + HW, b.y],
          state: edgeState,
        });
      } else {
        // single-row or top-row of U-shape: left → right
        edges.push({
          from: [a.x + HW, a.y],
          to: [b.x - HW, b.y],
          state: edgeState,
        });
      }
    }
    const last = nodes[nodes.length - 1]!;
    edges.push({
      from: isUShape ? [last.x - HW, last.y] : [last.x + HW, last.y],
      to: [goalPos.x - (isUShape ? -22 : 22), goalPos.y],
      state: last.state === 'done' ? 'done' : 'next',
    });
  }

  const progressPct = Math.min(
    100,
    Math.round((summary.done / Math.max(1, summary.done + summary.running + summary.queued)) * 100),
  );

  return (
    <div className="relative h-full w-full">
      {/* Header overlay */}
      <div className="pointer-events-none absolute top-5 right-6 left-6 z-[2]">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <div>
            <div className="t-eyebrow mb-0.5">
              {headlineState === 'planned'
                ? t('goap.headline.computed', 'Computed plan')
                : headlineState === 'empty'
                  ? t('goap.headline.satisfied', 'Goal already satisfied')
                  : t('goap.headline.preview', 'Plan preview')}
            </div>
            <div style={{ fontFamily: 'var(--f-head)', fontSize: 14, fontWeight: 500 }}>
              {headlineState === 'planned' ? (
                <>
                  <span style={{ color: 'var(--mint)' }}>
                    {t('goap.summary.steps', '{{count}} steps', { count: summary.done })}
                  </span>
                  <span className="t-faint" style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}>
                    {' '}
                    · {t('goap.summary.cost', 'cost')} {summary.cost} · {summary.eta}
                  </span>
                </>
              ) : headlineState === 'empty' ? (
                <span className="t-dim">
                  {t('goap.summary.noActionsNeeded', 'no actions needed')}
                </span>
              ) : (
                <>
                  <span className="t-dim">
                    {t('goap.summary.queued', '{{count}} actions queued', {
                      count: summary.queued,
                    })}
                  </span>
                  <span className="t-faint" style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}>
                    {' '}
                    · {t('goap.summary.estCost', 'est cost')} {summary.cost} · {summary.eta}
                  </span>
                </>
              )}
            </div>
          </div>
          {overflowCount > 0 && (
            <div
              className="pointer-events-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
              style={{
                borderColor: 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.4)',
                background: 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.1)',
                color: 'var(--coral)',
                fontFamily: 'var(--f-mono)',
              }}
              title={t(
                'goap.canvas.overflowTitle',
                'The canvas shows at most 8 nodes — the full plan is listed below.',
              )}
            >
              <AlertTriangle className="h-3 w-3" />
              {t('goap.canvas.overflow', '+{{count}} more not shown', { count: overflowCount })}
            </div>
          )}
        </div>
        {showProgress && (
          <div
            className="overflow-hidden rounded-[2px]"
            style={{
              height: 3,
              background: 'var(--wisp-glass-inset)',
              border: '1px solid var(--wisp-hairline)',
            }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('goap.canvas.progressLabel', 'Plan progress')}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                background:
                  'linear-gradient(90deg, var(--mint) 0%, var(--mint) 60%, var(--coral) 100%)',
                boxShadow: 'var(--wisp-glow-coral)',
                transition: 'width 1.2s var(--wisp-easing)',
              }}
            />
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
        aria-hidden
      >
        <defs>
          <pattern id="goap-dot" width="32" height="32" patternUnits="userSpaceOnUse">
            <circle cx="16" cy="16" r="0.9" fill="var(--wisp-svg-grid-dot)" />
          </pattern>
          <radialGradient id="goap-now-glow">
            <stop offset="0%" stopColor="var(--coral)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--coral)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="goap-done-glow">
            <stop offset="0%" stopColor="var(--mint)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--mint)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#goap-dot)" />

        {/* atmosphere blobs — anchored on the active plan row so the warm
            wash sits behind the nodes regardless of single-row or U-shape. */}
        <ellipse cx={W * 0.51} cy={ambientY} rx={180} ry={110} fill="url(#goap-now-glow)" />
        <ellipse cx={W * 0.26} cy={ambientY} rx={160} ry={80} fill="url(#goap-done-glow)" />

        {edges.map((e, i) => (
          <GoapEdge key={i} from={e.from} to={e.to} state={e.state} bend={e.bend} />
        ))}

        {/* Start marker */}
        <g>
          <circle
            cx={start.x}
            cy={start.y}
            r={22}
            fill="var(--wisp-svg-card)"
            stroke="var(--mint)"
            strokeWidth="2"
          />
          <circle
            cx={start.x}
            cy={start.y}
            r={14}
            fill="hsl(var(--mint-h) var(--mint-s) var(--mint-l) / 0.28)"
            stroke="none"
          />
          <path
            d={`M ${start.x - 4} ${start.y - 5} L ${start.x + 5} ${start.y} L ${start.x - 4} ${start.y + 5} Z`}
            fill="var(--mint)"
          />
          <text
            x={start.x}
            y={start.y + 42}
            textAnchor="middle"
            fontFamily="var(--f-display)"
            fontSize="14"
            fill="var(--wisp-ink)"
          >
            {startLabel}
          </text>
          <text
            x={start.x}
            y={start.y + 58}
            textAnchor="middle"
            fontFamily="var(--f-mono)"
            fontSize="9.5"
            fill="var(--wisp-ink-3)"
          >
            {startSub}
          </text>
        </g>

        {/* Goal marker */}
        <g>
          <circle
            cx={goalPos.x}
            cy={goalPos.y}
            r={28}
            fill="none"
            stroke="var(--coral)"
            strokeWidth="1.4"
            strokeDasharray="3 4"
            opacity="0.5"
          />
          <circle
            cx={goalPos.x}
            cy={goalPos.y}
            r={22}
            fill="var(--wisp-svg-card)"
            stroke="var(--coral)"
            strokeWidth="2"
          />
          <circle
            cx={goalPos.x}
            cy={goalPos.y}
            r={14}
            fill="hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.25)"
            stroke="none"
          />
          <g transform={`translate(${goalPos.x - 4}, ${goalPos.y - 6})`}>
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="12"
              stroke="var(--coral)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path d="M 0 0 L 7 3 L 0 5 Z" fill="var(--coral)" />
          </g>
          <text
            x={goalPos.x}
            y={goalPos.y + 46}
            textAnchor="middle"
            fontFamily="var(--f-display)"
            fontSize="14"
            fill="var(--wisp-ink)"
          >
            {goalLabel}
          </text>
          <text
            x={goalPos.x}
            y={goalPos.y + 62}
            textAnchor="middle"
            fontFamily="var(--f-mono)"
            fontSize="9.5"
            fill="var(--wisp-ink-3)"
          >
            {goalSub}
          </text>
        </g>

        {nodes.map((n) => (
          <GoapNodeCard key={n.i} node={n} hw={HW} hh={HH} />
        ))}
      </svg>
    </div>
  );
}

function jsonOrUndefined<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reconcile the enabled-action set when the actions JSON changes: brand-new
 * names (absent from the previously-parsed `known` set) default to enabled;
 * names that already existed keep their previous on/off state. Exported for
 * unit testing — the dead-branch bug here used to re-enable a toggled-off action
 * on any JSON edit.
 */
export function reconcileEnabledActions(
  prev: Set<string>,
  known: Set<string>,
  names: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (!known.has(n) || prev.has(n)) out.add(n);
  }
  return out;
}

export function GoapRoute() {
  const { t } = useTranslation();
  const [initialJson, setInitialJson] = useState(EXAMPLE_INITIAL);
  const [goalJson, setGoalJson] = useState(EXAMPLE_GOAL);
  const [actionsJson, setActionsJsonRaw] = useState(JSON.stringify(EXAMPLE_ACTIONS, null, 2));
  const [editorOpen, setEditorOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(EXAMPLE_ACTIONS.map((a) => a.name)),
  );
  // Names present in the previously-parsed actions JSON — lets us tell a
  // brand-new action (default enabled) apart from an existing one the user
  // toggled off (stays off) when the editor text changes.
  const knownActionNamesRef = useRef<Set<string>>(new Set(EXAMPLE_ACTIONS.map((a) => a.name)));
  const [parseError, setParseError] = useState<{
    kind: 'json' | 'validation';
    message: string;
  } | null>(null);
  const [actionsJsonError, setActionsJsonError] = useState<string | null>(null);
  const [initialJsonError, setInitialJsonError] = useState<string | null>(null);
  const [goalJsonError, setGoalJsonError] = useState<string | null>(null);
  const planM = usePlanGoap();
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Parse — fallback to sample so the canvas keeps showing the design when
  // the user is mid-edit, but track parse errors per field so we can show an
  // inline warning instead of silently swapping in EXAMPLE_ACTIONS.
  const initial = useMemo(() => {
    const v = jsonOrUndefined<Record<string, boolean>>(initialJson);
    return v ?? {};
  }, [initialJson]);
  const goal = useMemo(() => {
    const v = jsonOrUndefined<Record<string, boolean>>(goalJson);
    return v ?? {};
  }, [goalJson]);
  const actions = useMemo(() => {
    const v = jsonOrUndefined<GoapAction[]>(actionsJson);
    return Array.isArray(v) && v.every((a) => a && typeof a.name === 'string')
      ? v
      : EXAMPLE_ACTIONS;
  }, [actionsJson]);
  // Wrapping `setActionsJson` so any new action name added via the editor is
  // auto-enabled and any deleted names drop out of the enabled set. Without
  // this, a user adding `{"name":"newAction",...}` to the textarea would see
  // the action listed in the library but it would be silently excluded from
  // the planner submit because `enabled` still held only the example names.
  const setActionsJson = useCallback((next: string) => {
    setActionsJsonRaw(next);
    try {
      const parsed = JSON.parse(next) as GoapAction[];
      if (!Array.isArray(parsed)) throw new Error('actions must be an array');
      const names = new Set<string>();
      for (const a of parsed) {
        if (a && typeof a.name === 'string') names.add(a.name);
      }
      const known = knownActionNamesRef.current;
      setEnabled((prev) => reconcileEnabledActions(prev, known, names));
      knownActionNamesRef.current = names;
      setActionsJsonError(null);
    } catch (err) {
      setActionsJsonError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setInitialJson_ = useCallback((next: string) => {
    setInitialJson(next);
    try {
      JSON.parse(next);
      setInitialJsonError(null);
    } catch (err) {
      setInitialJsonError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const setGoalJson_ = useCallback((next: string) => {
    setGoalJson(next);
    try {
      JSON.parse(next);
      setGoalJsonError(null);
    } catch (err) {
      setGoalJsonError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const submit = useCallback(() => {
    if (planM.isPending) return;
    setParseError(null);
    try {
      const parsedActions = JSON.parse(actionsJson) as GoapAction[];
      const filtered = parsedActions.filter((a) => enabled.has(a.name));
      if (filtered.length === 0) {
        setParseError({
          kind: 'validation',
          message: t(
            'goap.errors.noActionsEnabled',
            'No actions enabled — pick at least one action from the library.',
          ),
        });
        return;
      }
      const body = {
        initial: JSON.parse(initialJson),
        goal: JSON.parse(goalJson),
        actions: filtered,
      };
      planM.mutate(body);
    } catch (err) {
      setParseError({
        kind: 'json',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [actionsJson, enabled, goalJson, initialJson, planM, t]);

  // Cmd/Ctrl+Enter triggers submit from anywhere on the route (matches
  // what users expect from JSON-editor flows in IDEs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  // Move focus to the plan result when a plan first lands so keyboard users
  // are not stranded on the submit button.
  useEffect(() => {
    if (planM.isSuccess && resultRef.current) {
      resultRef.current.focus();
    }
  }, [planM.isSuccess]);

  const loadExample = () => {
    setInitialJson(EXAMPLE_INITIAL);
    setGoalJson(EXAMPLE_GOAL);
    setActionsJsonRaw(JSON.stringify(EXAMPLE_ACTIONS, null, 2));
    setEnabled(new Set(EXAMPLE_ACTIONS.map((a) => a.name)));
    setParseError(null);
    setActionsJsonError(null);
    setInitialJsonError(null);
    setGoalJsonError(null);
    planM.reset();
  };

  // Build laid-out nodes: prefer plan from API; fallback to actions list.
  const layout = useMemo(() => {
    const plan = planM.data?.plan;
    if (plan && plan.length > 0) {
      return layoutActions(plan, plan.length, -1);
    }
    return layoutActions(actions, 0, -1);
  }, [planM.data?.plan, actions]);
  const headlineState: 'ready' | 'planned' | 'empty' = planM.data?.plan
    ? planM.data.plan.length > 0
      ? 'planned'
      : 'empty'
    : 'ready';

  const summary = useMemo(() => {
    const plan = planM.data?.plan;
    // Pre-plan "est cost" must reflect what would actually be submitted —
    // i.e. only the actions the user has checked in the library. Including
    // disabled actions in the fallback sum is misleading.
    const enabledActions = actions.filter((a) => enabled.has(a.name));
    const total = plan?.length ?? enabledActions.length;
    const cost = planM.data?.totalCost ?? enabledActions.reduce((s, a) => s + a.cost, 0);
    return {
      done: plan ? plan.length : 0,
      running: 0,
      queued: plan ? 0 : total,
      cost: cost ?? 0,
      eta: `~${Math.max(1, Math.round((cost ?? 0) / 4))} min`,
    };
  }, [planM.data, actions, enabled]);

  const filteredActions = useMemo(
    () => actions.filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase())),
    [actions, filter],
  );

  const toggle = (name: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const goalLabel = useMemo(() => {
    const keys = Object.keys(goal);
    if (!keys.length) return t('goap.node.satisfied', 'satisfied');
    return keys.slice(0, 2).join(', ');
  }, [goal, t]);

  const startLabel = useMemo(() => {
    const keys = Object.keys(initial);
    if (!keys.length) return t('goap.node.empty', 'empty');
    return keys.slice(0, 2).join(', ');
  }, [initial, t]);

  return (
    <div className="wisp-fade-up flex h-[calc(100vh-3.5rem-3rem)] flex-col">
      {/* Header */}
      <div className="mb-3.5 flex items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="t-eyebrow mb-1">{t('goap.eyebrow', 'Goal-Oriented Action Planning')}</div>
          <h1
            className="m-0"
            style={{
              fontFamily: 'var(--f-display)',
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: '-0.02em',
              lineHeight: 1.08,
            }}
          >
            {t('goap.title')}
          </h1>
          <div className="mt-1.5 max-w-2xl text-sm-tight text-[color:var(--wisp-ink-3)]">
            {t(
              'goap.subtitleLong',
              'Define start and goal state, pick available actions — the planner returns the shortest sequence.',
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="wisp-btn"
            onClick={loadExample}
            disabled={planM.isPending}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('goap.actions.loadExample', 'Load example')}
          </button>
          <button
            type="button"
            className="wisp-btn"
            onClick={() => {
              setParseError(null);
              planM.reset();
            }}
            disabled={planM.isPending || (!planM.data && !planM.error && !parseError)}
            title={t('goap.actions.clearHint', 'Clear the current plan result')}
          >
            <RefreshCw className="h-3.5 w-3.5" /> {t('goap.actions.clear', 'Clear')}
          </button>
          <button
            type="button"
            className="wisp-btn primary"
            onClick={submit}
            disabled={planM.isPending}
            title={t('goap.actions.planHint', 'Run plan (Cmd/Ctrl+Enter)')}
          >
            <Play className="h-3.5 w-3.5" />
            {planM.isPending
              ? t('goap.actions.planning', 'Planning…')
              : t('goap.actions.plan', 'Run plan')}
          </button>
        </div>
      </div>

      {/* 3-column grid — stacks below the lg breakpoint so narrow viewports
          don't break the canvas. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
        {/* World state */}
        <div className="wisp-card overflow-auto">
          <div className="t-eyebrow mb-3">{t('goap.worldState', 'World state')}</div>
          <div className="flex flex-col gap-3.5">
            <div>
              <div
                className="mb-2 flex items-center gap-1.5"
                style={{ fontFamily: 'var(--f-head)', fontSize: 12, color: 'var(--wisp-ink-2)' }}
              >
                <span className="wisp-dot amber" /> {t('goap.fields.start', 'Start')}
              </div>
              <div className="flex flex-col gap-1">
                {Object.entries(initial).length === 0 ? (
                  <StateLine k={t('goap.worldStateLabels.empty', '(empty)')} v="—" />
                ) : (
                  Object.entries(initial).map(([k, v]) => <StateLine key={k} k={k} v={String(v)} />)
                )}
              </div>
            </div>
            <div>
              <div
                className="mb-2 flex items-center gap-1.5"
                style={{ fontFamily: 'var(--f-head)', fontSize: 12, color: 'var(--wisp-ink-2)' }}
              >
                <span className="wisp-dot mint" /> {t('goap.fields.goal', 'Goal')}
              </div>
              <div className="flex flex-col gap-1">
                {Object.entries(goal).map(([k, v]) => (
                  <StateLine key={k} k={k} v={String(v)} on />
                ))}
              </div>
            </div>
            <div>
              <div
                className="mb-2 flex items-center gap-1.5"
                style={{ fontFamily: 'var(--f-head)', fontSize: 12, color: 'var(--wisp-ink-2)' }}
              >
                <span className="wisp-dot violet" /> {t('goap.stats.title', 'Stats')}
              </div>
              <div className="flex flex-col gap-1.5 text-[12.5px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-eyebrow">{t('goap.stats.actions', 'actions')}</span>
                  <span style={{ color: 'var(--wisp-ink-2)' }}>
                    {t('goap.stats.enabledRatio', '{{enabled}} of {{total}} enabled', {
                      enabled: enabled.size,
                      total: actions.length,
                    })}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-eyebrow">{t('goap.stats.cost', 'cost')}</span>
                  <span className="t-mono" style={{ color: 'var(--wisp-ink-2)' }}>
                    {summary.cost}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-eyebrow">{t('goap.stats.eta', 'eta')}</span>
                  <span style={{ color: 'var(--wisp-ink-2)' }}>{summary.eta}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Canvas */}
        {/* For single-row layouts (≤5 actions) the SVG canvas only needs a
            short card height — the row + Start/Goal markers fit comfortably
            in ~360px. self-start keeps the card anchored at the top of the
            3-column grid row so the world-state column drives the row
            height (it has more content) without stretching the canvas into
            empty wallpaper. */}
        <div
          className={cn(
            'wisp-card relative overflow-hidden p-0',
            !layout.isUShape && 'h-[360px] self-start',
          )}
          role="region"
          aria-label={
            headlineState === 'planned'
              ? t('goap.canvas.ariaPlanned', 'Plan visualization: {{steps}} steps, cost {{cost}}', {
                  steps: summary.done,
                  cost: summary.cost,
                })
              : headlineState === 'empty'
                ? t('goap.canvas.ariaEmpty', 'Plan visualization: goal already satisfied')
                : t('goap.canvas.ariaPreview', 'Plan preview: {{count}} actions queued', {
                    count: summary.queued,
                  })
          }
        >
          <GoapCanvas
            layout={layout}
            startLabel={t('goap.canvas.start', 'Start')}
            goalLabel={t('goap.canvas.goal', 'Goal')}
            startSub={startLabel}
            goalSub={goalLabel}
            summary={summary}
            headlineState={headlineState}
            overflowCount={Math.max(0, actions.length - 8)}
            showProgress={headlineState !== 'ready'}
          />
        </div>

        {/* Actions library */}
        <div className="wisp-card overflow-auto">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="t-eyebrow">{t('goap.actionsLibrary', 'Actions library')}</div>
          </div>
          <div
            className="mb-3 flex items-center gap-2"
            style={{
              background: 'var(--wisp-glass-inset)',
              border: '1px solid var(--wisp-hairline)',
              padding: '6px 10px',
              borderRadius: 'var(--r-2)',
            }}
          >
            <Search className="h-3 w-3 text-[color:var(--wisp-ink-3)]" />
            <input
              id="goap-filter"
              name="goap-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              disabled={planM.isPending}
              placeholder={t('goap.filterActions', 'Filter actions…')}
              aria-label={t('goap.filterActionsAria', 'Filter actions by name')}
              className="flex-1 border-none bg-transparent text-xs text-[color:var(--wisp-ink)] outline-none disabled:opacity-60"
            />
          </div>
          <div className="flex flex-col gap-2">
            {filteredActions.length === 0 && (
              <div className="t-faint p-2 text-center" style={{ fontSize: 11 }} role="status">
                {filter
                  ? t('goap.library.noMatches', 'No actions match this filter.')
                  : t('goap.library.empty', 'No actions defined. Edit JSON to add some.')}
              </div>
            )}
            {filteredActions.map((a) => (
              <label
                key={a.name}
                className={cn(
                  'wisp-surface flex cursor-pointer items-start gap-2.5 p-2.5',
                  planM.isPending && 'pointer-events-none opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={enabled.has(a.name)}
                  onChange={() => toggle(a.name)}
                  disabled={planM.isPending}
                  className="mt-0.5"
                  style={{ accentColor: 'var(--coral)' }}
                  aria-label={t('goap.library.toggleAria', 'Toggle action {{name}}', {
                    name: a.name,
                  })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span
                      className="t-mono truncate"
                      style={{ fontSize: 12, color: 'var(--wisp-ink)' }}
                      title={a.name}
                    >
                      {a.name}
                    </span>
                    <span className="t-mono t-faint shrink-0" style={{ fontSize: 10 }}>
                      {t('goap.library.costSuffix', '{{cost}} cost', { cost: a.cost })}
                    </span>
                  </div>
                  <div className="t-faint mt-0.5 truncate" style={{ fontSize: 10.5 }}>
                    {shortFlag(a.preconditions, '—')} → {shortFlag(a.effects, '—')}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* JSON editor drawer */}
      <div className="mt-3.5">
        <button
          type="button"
          className="wisp-btn ghost sm"
          onClick={() => setEditorOpen((o) => !o)}
          aria-expanded={editorOpen}
          aria-controls="goap-json-editor"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', !editorOpen && '-rotate-90')}
          />
          {t('goap.rawEditor', 'Edit JSON')}
        </button>
        {editorOpen && (
          <div id="goap-json-editor" className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              {
                label: t('goap.fields.start', 'Start'),
                value: initialJson,
                set: setInitialJson_,
                error: initialJsonError,
              },
              {
                label: t('goap.fields.goal', 'Goal'),
                value: goalJson,
                set: setGoalJson_,
                error: goalJsonError,
              },
              {
                label: t('goap.fields.actions', 'Actions'),
                value: actionsJson,
                set: setActionsJson,
                error: actionsJsonError,
              },
            ].map(({ label, value, set, error }) => (
              <div key={label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="t-eyebrow">{label}</label>
                  {error && (
                    <span
                      className="t-mono"
                      style={{ fontSize: 10.5, color: 'var(--rose)' }}
                      title={error}
                    >
                      {t('goap.editor.invalidJson', 'invalid JSON')}
                    </span>
                  )}
                </div>
                <textarea
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  disabled={planM.isPending}
                  aria-label={label}
                  aria-invalid={!!error}
                  className="h-40 rounded-md border p-2 font-mono text-xs focus:outline-none focus:ring-2 disabled:opacity-60"
                  style={{
                    borderColor: error ? 'var(--rose)' : 'var(--wisp-hairline)',
                    background: 'var(--wisp-glass-inset)',
                    color: 'var(--wisp-ink)',
                  }}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        )}
        {parseError && (
          <div
            className="mt-2 flex items-start gap-2 text-sm"
            style={{ color: 'var(--rose)' }}
            role="alert"
            aria-live="assertive"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {parseError.kind === 'json'
                ? `${t('goap.errors.jsonPrefix', 'JSON error:')} ${parseError.message}`
                : parseError.message}
            </span>
          </div>
        )}
        {planM.error && (
          <div
            className="mt-2 flex items-start gap-2 text-sm"
            style={{ color: 'var(--rose)' }}
            role="alert"
            aria-live="assertive"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t('goap.errors.requestPrefix', 'Planner request failed:')}{' '}
              {planM.error instanceof Error ? planM.error.message : String(planM.error)}
            </span>
          </div>
        )}
        {planM.data && (
          <div ref={resultRef} tabIndex={-1} aria-live="polite">
            <PlanResult data={planM.data} />
          </div>
        )}
      </div>
    </div>
  );
}

function PlanResult({ data }: { data: GoapPlanResponse }) {
  const { t } = useTranslation();
  // Defensive parse — if the backend ever sends a malformed payload (string,
  // number, missing fields) we fall through to the "no plan" branch instead
  // of crashing the route.
  if (data.plan != null && !Array.isArray(data.plan)) {
    return (
      <div className="wisp-card mt-3 p-3 text-sm" role="status">
        {t(
          'goap.result.malformed',
          'Planner returned an unexpected response — please retry or check the server logs.',
        )}
      </div>
    );
  }
  if (!data.plan) {
    return (
      <div className="wisp-card mt-3 p-3 text-sm" role="status">
        {t('goap.result.noPlan', 'No plan exists for this initial/goal/actions combination.')}
      </div>
    );
  }
  if (data.plan.length === 0) {
    return (
      <div className="wisp-card mt-3 p-3 text-sm" role="status">
        {t('goap.result.alreadySat', 'Goal already satisfied — empty plan.')}
      </div>
    );
  }
  return (
    <div className="wisp-card mt-3 p-3">
      <h2 className="t-eyebrow mb-2">
        {t('goap.result.title', 'Plan')} · {t('goap.summary.cost', 'cost')} {data.totalCost ?? '?'}
      </h2>
      <ol className="space-y-1 text-sm">
        {data.plan.map((a, i) => (
          <li key={i} className="flex items-baseline gap-3">
            <span className="t-mono t-faint">{i + 1}.</span>
            <span className="t-mono font-semibold">{a.name}</span>
            <span className="t-faint text-xs">
              {t('goap.result.costInline', 'cost: {{cost}}', { cost: a.cost })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

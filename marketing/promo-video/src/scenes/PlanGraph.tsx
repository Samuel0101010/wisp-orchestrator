import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { ramp, SPRING } from '../lib/anim';
import { Eyebrow } from '../components/primitives';
import { KineticText } from '../components/KineticText';
import { Stage } from '../components/Stage';

type GNode = { id: string; cx: number; cy: number; label: string; delay: number; gate?: boolean };

const NODE_W = 230;
const NODE_H = 86;

const H_BOX = { w: 1500, h: 540 };
const H_NODES: GNode[] = [
  { id: 'scaffold', cx: 125, cy: 270, label: 'Scaffold', delay: 14 },
  { id: 'api', cx: 520, cy: 135, label: 'Backend API', delay: 46 },
  { id: 'ui', cx: 520, cy: 405, label: 'Web UI', delay: 64 },
  { id: 'tests', cx: 960, cy: 270, label: 'Tests', delay: 116 },
  { id: 'gate', cx: 1360, cy: 270, label: 'Gate', delay: 168, gate: true },
];

const V_BOX = { w: 600, h: 1040 };
const V_NODES: GNode[] = [
  { id: 'scaffold', cx: 300, cy: 90, label: 'Scaffold', delay: 14 },
  { id: 'api', cx: 160, cy: 380, label: 'Backend API', delay: 46 },
  { id: 'ui', cx: 440, cy: 380, label: 'Web UI', delay: 64 },
  { id: 'tests', cx: 300, cy: 670, label: 'Tests', delay: 116 },
  { id: 'gate', cx: 300, cy: 950, label: 'Gate', delay: 168, gate: true },
];

const EDGES = [
  { from: 'scaffold', to: 'api', start: 60 },
  { from: 'scaffold', to: 'ui', start: 78 },
  { from: 'api', to: 'tests', start: 130 },
  { from: 'ui', to: 'tests', start: 138 },
  { from: 'tests', to: 'gate', start: 188 },
];

function edgePath(a: GNode, b: GNode, isV: boolean): string {
  if (isV) {
    const sx = a.cx;
    const sy = a.cy + NODE_H / 2;
    const ex = b.cx;
    const ey = b.cy - NODE_H / 2;
    const dy = ey - sy;
    return `M ${sx} ${sy} C ${sx} ${sy + dy * 0.5}, ${ex} ${ey - dy * 0.5}, ${ex} ${ey}`;
  }
  const sx = a.cx + NODE_W / 2;
  const sy = a.cy;
  const ex = b.cx - NODE_W / 2;
  const ey = b.cy;
  const dx = ex - sx;
  return `M ${sx} ${sy} C ${sx + dx * 0.5} ${sy}, ${ex - dx * 0.5} ${ey}, ${ex} ${ey}`;
}

const GraphEdge: React.FC<{ d: string; start: number }> = ({ d, start }) => {
  const frame = useCurrentFrame();
  const prog = ramp(frame, start, start + 20);
  return (
    <path
      d={d}
      fill="none"
      stroke={COLORS.coral}
      strokeOpacity={0.6}
      strokeWidth={3.5}
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - prog}
    />
  );
};

const EdgeFlow: React.FC<{ d: string; start: number }> = ({ d, start }) => {
  const frame = useCurrentFrame();
  if (frame < start + 20) return null;
  const loop = (((frame - (start + 20)) % 42) / 42) * 100;
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 10,
        height: 10,
        marginLeft: -5,
        marginTop: -5,
        borderRadius: '50%',
        background: COLORS.coralBright,
        boxShadow: `0 0 14px ${COLORS.coral}, 0 0 6px #fff`,
        offsetPath: `path('${d}')`,
        offsetDistance: `${loop}%`,
        offsetRotate: '0deg',
      }}
    />
  );
};

const GraphNode: React.FC<{ n: GNode }> = ({ n }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - n.delay, fps, config: SPRING.pop });
  const done = n.gate ? frame > n.delay + 26 : false;
  const dotColor = done ? COLORS.green : COLORS.coral;
  return (
    <div
      style={{
        position: 'absolute',
        left: n.cx - NODE_W / 2,
        top: n.cy - NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
        opacity: p,
        transform: `scale(${interpolate(p, [0, 1], [0.82, 1])})`,
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '0 20px',
        borderRadius: 18,
        background: COLORS.card,
        border: `1px solid ${done ? COLORS.green + 'aa' : COLORS.cardBorderBright}`,
        boxShadow: done
          ? `0 0 40px ${COLORS.green}55, 0 20px 56px rgba(0,0,0,0.55)`
          : `0 0 26px rgba(217,121,89,0.12), 0 20px 56px rgba(0,0,0,0.55)`,
      }}
    >
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: `0 0 14px ${dotColor}`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 23, fontWeight: 600, color: COLORS.fg, whiteSpace: 'nowrap' }}>{n.label}</span>
      {n.gate && done && (
        <span style={{ marginLeft: 'auto', color: COLORS.green, fontSize: 26, fontWeight: 700 }}>✓</span>
      )}
    </div>
  );
};

export const PlanGraph: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const isV = height > width;

  const box = isV ? V_BOX : H_BOX;
  const nodes = isV ? V_NODES : H_NODES;
  const byId = (id: string) => nodes.find((n) => n.id === id) as GNode;
  const paths = EDGES.map((e) => ({ d: edgePath(byId(e.from), byId(e.to), isV), start: e.start }));

  const chipP = spring({ frame: frame - 204, fps, config: SPRING.pop });

  return (
    <Stage dur={dur} push={0.04} drift={-8}>
      <AbsoluteFill
        style={{
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: isV ? 50 : 90,
          gap: isV ? 34 : 44,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <Eyebrow delay={8}>Step 2 — WISP plans the work</Eyebrow>
          <KineticText
            tokens={[{ t: 'Your goal becomes a' }, { t: 'dependency graph.', c: COLORS.coral }]}
            delay={20}
            fontSize={isV ? 54 : 72}
          />
        </div>

        <div style={{ position: 'relative', width: box.w, height: box.h }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${box.w} ${box.h}`} style={{ position: 'absolute', inset: 0 }}>
            {paths.map((p, i) => (
              <GraphEdge key={i} d={p.d} start={p.start} />
            ))}
          </svg>
          {paths.map((p, i) => (
            <EdgeFlow key={i} d={p.d} start={p.start} />
          ))}
          {nodes.map((n) => (
            <GraphNode key={n.id} n={n} />
          ))}
        </div>

        <div
          style={{
            opacity: chipP,
            transform: `scale(${interpolate(chipP, [0, 1], [0.85, 1])})`,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '9px 18px',
            borderRadius: 999,
            fontSize: 17,
            fontWeight: 600,
            color: COLORS.green,
            background: 'rgba(108,192,138,0.12)',
            border: `1px solid ${COLORS.green}55`,
          }}
        >
          <span>✓</span> Plan ready · dispatching 5 tasks
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

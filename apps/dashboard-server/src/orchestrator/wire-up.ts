/**
 * wire-up — reconciliation pass between parallel core-dev tasks and the
 * downstream QA / runtime-verify gates.
 *
 * Failure mode this addresses: when the planner emits 2+ parallel core-dev
 * tasks (`rust-backend`, `frontend-ui`, `power-features`, ...), each writes
 * files in its own worktree. The walker's dep-merge stitches the trees
 * together but cannot reason about cross-file wiring — e.g. a new React
 * component is committed but App.tsx was never edited to mount it, a Rust
 * `.emit()` call lacks `use tauri::Emitter;`, a brand-new build.rs is
 * missing because `tauri-build` is only in Cargo.toml.
 *
 * The wire-up role does the smallest possible cross-file reconciliation:
 *   - `pnpm install` (idempotent)
 *   - `pnpm typecheck` — read each error, fix the specific issue
 *   - `pnpm lint` (if present)
 *   - Mount newly-introduced React components into App.tsx / router
 *   - Add missing Tauri trait imports (Emitter, Listener, Manager)
 *   - Create canonical build.rs when tauri-build is declared but absent
 *   - DO NOT refactor working code, DO NOT add features, DO NOT remove tests
 *
 * The injection mechanic is intentionally a mirror of inject-runtime-verifier
 * + inject-lead-checkpoint so the call sites stay uniform. wire-up is
 * spliced in BEFORE runtime-verifier injection so that runtime-verifier
 * ends up depending on wire-up (verifier sees the reconciled tree, not
 * the raw parallel output).
 */

import type { AgentSpec, Plan, TaskNode } from '@wisp/schemas';
import { planSchema, MAX_TEAM_ROLES } from '@wisp/schemas';

const WIRE_UP_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git:*, pnpm:*, npm:*, npx:*, cargo:*, node:*)',
];

export const WIRE_UP_ROLE: AgentSpec = {
  role: 'wire-up',
  model: 'sonnet',
  allowedTools: WIRE_UP_TOOLS,
  systemPrompt: `You are the Wire-up reviewer. Prior core-dev tasks ran in parallel worktrees and have been merged. Your job is to reconcile cross-file inconsistencies so the project builds, typechecks, and renders. You do NOT add features, you do NOT refactor working code, you do NOT remove tests. Minimal-invasive only.

WORKFLOW (in order):

1. Inventory. \`git log --oneline -n 25\` + \`git diff --stat HEAD~10 HEAD\` to understand what the prior tasks touched. List newly-created source files (components, modules, hooks, Rust files) — these are the most likely wiring victims.

2. Install + typecheck. \`pnpm install\` (idempotent — skip if no package.json). Then \`pnpm typecheck\` (or \`npx tsc --noEmit\`). For every error: read the exact file/line, identify the SPECIFIC cause (unused import, missing import, wrong export path, undeclared variable), apply the minimal fix. Re-run until clean OR 3 attempts hit the same wall — then document in \`wire-up.notes.md\` and continue.

3. Lint. If \`pnpm lint\` exists, run it; fix import-order / unused-import warnings created by new files. Skip style-only opinion issues.

4. React mounting check. If \`src/App.tsx\`, \`src/main.tsx\`, \`src/app/page.tsx\`, or similar root component exists: Read it. Glob for \`src/components/**/*.tsx\` and \`src/views/**/*.tsx\` produced in the recent commits. For every component that is NOT imported anywhere in the JSX tree but was clearly added as a user-visible feature (default export, kebab/PascalCase Component name, lives under components/ or views/):
   - Overlays / portals / toasts → mount at the end of the root JSX tree.
   - Route components → wire into the router config (react-router, next/app, etc.).
   - Layout managers / providers → wrap appropriately high in the tree.
   - When unsure, prefer mounting at the end of the root component with a one-line comment explaining the heuristic.

5. Tauri / Rust wiring check. If \`src-tauri/\` or \`src/main.rs\` exists: grep all \`.rs\` files for trait-method calls and verify the trait is imported:
   - \`.emit(\` → \`use tauri::Emitter;\`
   - \`.listen(\` → \`use tauri::Listener;\`
   - \`.get_window(\`, \`.windows()\` from an AppHandle → \`use tauri::Manager;\`
   Add the missing \`use\` line at the top of each affected file, grouped with existing tauri imports.

6. Build.rs check. If \`src-tauri/Cargo.toml\` (or any Cargo.toml) declares \`[build-dependencies]\` with \`tauri-build\` but \`build.rs\` is missing in the same directory: create the canonical 3-line build.rs:
\`\`\`
fn main() {
    tauri_build::build()
}
\`\`\`

7. Build (best-effort). Run \`pnpm build\` if defined. Don't fail the task on native-toolchain errors (Tauri bundling, Rust cross-compile) — those are downstream concerns. DO fail on TypeScript / bundler errors.

8. Commit. For each batch of fixes commit with an explanatory message (\`wire-up: mount NewSettingsModal in App.tsx (was orphaned by power-features task)\` style). Commits explain WHY, never just WHAT.

HARD RULES:
- Minimal diffs only. If a fix needs more than ~10 lines, document it in \`wire-up.notes.md\` and skip — humans will handle it.
- Never delete a test. Never weaken an assertion.
- Never modify existing exports' signatures — that's a refactor, not a wire-up.
- If you can't determine the right mount point in <3 attempts, document and continue.
- If typecheck still fails after your fixes: report the remaining errors honestly in \`wire-up.notes.md\`. Don't paper over.

ACCEPTANCE:
- \`pnpm typecheck\` exits 0 (or remaining errors documented).
- \`pnpm lint\` exits 0 if it exists (warnings ok; errors must be fixed).
- \`pnpm build\` exits 0 best-effort (native-toolchain blockers exempted).
- Newly-created user-visible components are mounted somewhere in the JSX tree.
- All Rust files using Tauri trait methods import the required trait.`,
};

const WIRE_UP_NODE_ID = 'n-wire-up';
const DEFAULT_WIRE_UP_MAX_TURNS = 40;
const TEAM_ROLE_CAP = MAX_TEAM_ROLES;

/**
 * Heuristic role-name set we consider "core development" — terminal nodes
 * of these roles are the targets we splice wire-up behind. Anything else
 * (qa, test-dev, security-reviewer, runtime-verifier, lead) is treated as
 * downstream and gets rewired to depend on wire-up.
 *
 * Pattern-match on the suffix `-dev`, plus the exact roles `developer`,
 * `core-dev`, `frontend`, `backend`, `rust-backend`, `frontend-ui`,
 * `power-features`, and the prefix `feature-`. The set is intentionally
 * permissive — false-positives (treating a non-dev role as dev) just mean
 * wire-up runs after it too, which is harmless.
 */
const CORE_DEV_ROLE_NAMES = new Set([
  'core-dev',
  'developer',
  'frontend',
  'backend',
  'frontend-ui',
  'rust-backend',
  'power-features',
  'fullstack',
  'fullstack-dev',
]);

function isCoreDevRole(role: string): boolean {
  if (CORE_DEV_ROLE_NAMES.has(role)) return true;
  if (role.endsWith('-dev')) return true;
  if (role.startsWith('feature-')) return true;
  return false;
}

/**
 * Roles whose nodes are downstream of core-dev and must be rewired to
 * depend on wire-up after injection. The complement of "anything we'd
 * want to keep BEFORE wire-up".
 */
const DOWNSTREAM_ROLE_NAMES = new Set([
  'qa',
  'qa-engineer',
  'test-dev',
  'tester',
  'security-reviewer',
  'runtime-verifier',
  'lead',
  'packager',
  'release-engineer',
]);

function isDownstreamRole(role: string): boolean {
  return DOWNSTREAM_ROLE_NAMES.has(role);
}

export interface InjectWireUpArgs {
  plan: Plan;
  /** Override node id (defaults to `n-wire-up`). */
  nodeId?: string;
}

export interface InjectWireUpResult {
  plan: Plan;
  reason:
    | 'injected'
    | 'already-present'
    | 'team-cap-reached'
    | 'no-core-dev-nodes'
    | 'single-core-dev-skip'
    | 'plan-empty';
}

export function planHasWireUp(plan: Plan): boolean {
  return (
    plan.team.roles.some((r) => r.role === 'wire-up') ||
    plan.nodes.some((n) => n.role === 'wire-up')
  );
}

export interface BuildWireUpNodeArgs {
  id?: string;
  deps: string[];
  maxTurns?: number;
}

export function buildWireUpNode(args: BuildWireUpNodeArgs): TaskNode {
  return {
    id: args.id ?? WIRE_UP_NODE_ID,
    role: 'wire-up',
    prompt: `Reconcile the changes from the prior core-dev tasks so the project builds, typechecks, lints, and renders.

Follow the workflow in the system prompt verbatim:
1. Inventory recent commits.
2. \`pnpm install\` + \`pnpm typecheck\` — fix every reported error with the minimal change.
3. Lint — fix import / unused-import issues introduced by new files.
4. React mounting — mount orphaned components into the JSX tree.
5. Tauri / Rust trait imports — add \`use tauri::{Emitter,Listener,Manager};\` where used but not imported.
6. build.rs — create canonical 3-line build.rs when \`tauri-build\` is declared but the file is missing.
7. Best-effort \`pnpm build\`.
8. Commit fixes individually with WHY-focused messages.

Hard rules: minimal diffs, no refactors, no feature additions, no test deletions. Document anything you can't fix in \`wire-up.notes.md\`.`,
    deps: args.deps,
    successCriteria: {
      build: 'pnpm install && pnpm typecheck',
    },
    maxTurns: args.maxTurns ?? DEFAULT_WIRE_UP_MAX_TURNS,
  };
}

/**
 * Find nodes that look like "the last core-dev step" — roles in the
 * core-dev family, with no other core-dev node depending on them.
 *
 * In a typical plan (architect → core-devs → qa) every core-dev node is a
 * terminal among core-devs, so they all become wire-up's deps.
 */
function findCoreDevLeafIds(plan: Plan): string[] {
  const coreDevIds = new Set(plan.nodes.filter((n) => isCoreDevRole(n.role)).map((n) => n.id));
  if (coreDevIds.size === 0) return [];

  const referencedByCoreDev = new Set<string>();
  for (const n of plan.nodes) {
    if (!isCoreDevRole(n.role)) continue;
    for (const d of n.deps) {
      if (coreDevIds.has(d)) referencedByCoreDev.add(d);
    }
  }
  return [...coreDevIds].filter((id) => !referencedByCoreDev.has(id));
}

/**
 * Splice wire-up between core-dev leaves and any downstream consumers.
 *
 * Strategy:
 *   1. Identify core-dev leaf nodes (deps).
 *   2. Add wire-up node that depends on those leaves.
 *   3. For any downstream-role node whose deps include one of those leaves,
 *      replace that dep with the wire-up node id (so wire-up runs first).
 *   4. Update edges symmetrically.
 *
 * Backward-compat: if a plan has no core-dev-like roles at all, we skip
 * injection (reason: 'no-core-dev-nodes') so legacy library / refactor
 * plans pass through untouched.
 */
export function injectWireUp(args: InjectWireUpArgs): InjectWireUpResult {
  if (planHasWireUp(args.plan)) {
    return { plan: args.plan, reason: 'already-present' };
  }
  if (args.plan.nodes.length === 0) {
    return { plan: args.plan, reason: 'plan-empty' };
  }
  if (args.plan.team.roles.length >= TEAM_ROLE_CAP) {
    return { plan: args.plan, reason: 'team-cap-reached' };
  }

  const coreDevLeaves = findCoreDevLeafIds(args.plan);
  if (coreDevLeaves.length === 0) {
    return { plan: args.plan, reason: 'no-core-dev-nodes' };
  }
  // Single linear core-dev → no cross-file reconciliation to do. Skip
  // injection so legacy 3-task (architect → developer → qa) plans keep
  // their original shape and existing e2e tests still pass.
  if (coreDevLeaves.length < 2) {
    return { plan: args.plan, reason: 'single-core-dev-skip' };
  }

  const wireUpId = args.nodeId ?? WIRE_UP_NODE_ID;
  const leafSet = new Set(coreDevLeaves);

  // Rewire downstream nodes: any node with a downstream-role whose deps
  // include a core-dev leaf gets that dep redirected to wire-up. Non-
  // downstream nodes (other core-devs etc.) keep their direct deps.
  const rewrittenNodes: TaskNode[] = args.plan.nodes.map((n) => {
    if (!isDownstreamRole(n.role)) return n;
    const touchesLeaf = n.deps.some((d) => leafSet.has(d));
    if (!touchesLeaf) return n;
    const newDeps = new Set<string>();
    for (const d of n.deps) {
      newDeps.add(leafSet.has(d) ? wireUpId : d);
    }
    return { ...n, deps: [...newDeps] };
  });

  // Edges: rewrite any edge whose `from` is a leaf AND whose `to` is a
  // downstream node — that edge becomes `wire-up → downstream`. The
  // original `leaf → downstream` edges are replaced (not duplicated).
  const downstreamIds = new Set(
    args.plan.nodes.filter((n) => isDownstreamRole(n.role)).map((n) => n.id),
  );
  const rewrittenEdges: { from: string; to: string }[] = [];
  for (const e of args.plan.edges) {
    if (leafSet.has(e.from) && downstreamIds.has(e.to)) {
      rewrittenEdges.push({ from: wireUpId, to: e.to });
    } else {
      rewrittenEdges.push(e);
    }
  }
  // Add leaf → wire-up edges.
  for (const leaf of coreDevLeaves) {
    rewrittenEdges.push({ from: leaf, to: wireUpId });
  }

  const wireUpNode = buildWireUpNode({ id: wireUpId, deps: coreDevLeaves });

  const out: Plan = {
    goal: args.plan.goal,
    team: { roles: [...args.plan.team.roles, WIRE_UP_ROLE] },
    nodes: [...rewrittenNodes, wireUpNode],
    edges: rewrittenEdges,
  };

  // Re-validate. If our transform broke the shape (e.g. duplicate edges
  // a future schema disallows), fail closed by handing back the input.
  const safe = planSchema.safeParse(out);
  if (!safe.success) {
    return { plan: args.plan, reason: 'plan-empty' };
  }
  return { plan: out, reason: 'injected' };
}

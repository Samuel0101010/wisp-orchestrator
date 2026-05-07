---
date: 2026-05-07
tags: [orchestrator, walker, replan, git-worktree, branch-prefix]
files:
  - packages/orchestrator/src/walker.ts
related:
  - 2026-05-07-claude-cli-session-id-capture.md
---

# Replan branch-prefix: carried-over `done` deps live under the OLD prefix

## Problem

After a QA-triggered replan, any new task whose dependency is a carried-over
`done` task (preserved across the plan swap) failed at `git worktree add` with
"fatal: invalid reference". The replan path was effectively broken for any DAG
where new tasks reference old done tasks. Trivial linear 3-node DAGs
(architect→dev→qa) didn't expose it because the QA failure terminates that
chain — the bug only manifests when post-replan tasks have cross-boundary
deps.

## Root cause

The walker namespaces branches via `branchPrefix()`:

- Original plan:    `harness/<runId>/<taskId>`
- After 1st replan: `harness/<runId>/v2/<taskId>`

Carried-over `done` tasks keep their **original** branch
(`harness/<runId>/B`). But three call sites synthesized branch names from the
**current** `branchPrefix()`, producing references like `harness/<runId>/v2/B`
for a dep B whose actual branch was `harness/<runId>/B`:

1. `finalizeResultBranch` — fixed in PR #14 with `t.branchName ?? branchPrefix()/n.id` fallback.
2. `computeParentBranch` (used as `worktree.add` baseBranch) — **missed**.
3. `otherDepBranches` mapping (used in `mergeBranchesInWorktree`) — **missed**.

Same-bug-different-place: PR #14 fixed one of three. Two other call sites
silently rotted with the same logic flaw.

## Solution

Extract a single helper that resolves a dep id to its actual git branch name,
preferring the runtime's stored `branchName` for `done` tasks (which is
authoritative for carried-over branches across replan boundaries):

```ts
private branchForDep(depId: string): string {
  const dep = this.tasks.get(depId);
  if (dep?.status === 'done' && dep.branchName) return dep.branchName;
  return `${this.branchPrefix()}/${depId}`;
}

private computeParentBranch(node: TaskNode): string | undefined {
  const firstDep = node.deps[0];
  if (firstDep === undefined) return undefined;
  return this.branchForDep(firstDep);
}

// In runTask, for multi-dep merges:
const otherDepBranches = node.deps.slice(1).map((d) => this.branchForDep(d));
```

## Key snippets

```ts
// packages/orchestrator/src/walker.ts
private branchForDep(depId: string): string {
  const dep = this.tasks.get(depId);
  if (dep?.status === 'done' && dep.branchName) return dep.branchName;
  return `${this.branchPrefix()}/${depId}`;
}
```

## Verification

- All existing orchestrator tests (82 passing) green.
- Existing replan test exercises the carried-over-done-tasks path.
- Manual smoke (deferred): trigger a 4-node DAG replan where a new task
  depends on a carried-over done dep; verify `git worktree add` succeeds and
  references the old prefix's branch.

## Lessons

- **Same-bug-different-place is a recurring pattern.** When you fix a logic
  bug, immediately grep for the same pattern at other call sites. PR #14 had
  the right fix for `finalizeResultBranch` but didn't audit
  `computeParentBranch` or `otherDepBranches` which used the same flawed
  template-string composition.
- **Bug only manifests in non-trivial DAGs.** Linear chains and 3-node tests
  don't trigger it; the bug requires `new task → carried-over done dep` —
  i.e. a DAG where the post-replan plan keeps the same architecture but
  changes downstream tasks. Templates like `ts-library` (4 roles fan-in) are
  the natural trigger.
- **Cross-cutting reviewers find this; per-file static review doesn't.**
  Round 4 fixed one CRITICAL via behavioral review (planner.md hardcoding);
  Round 5 fixed this CRITICAL via the same review style. Static reviewers
  see one file at a time and miss "fix-pattern A but pattern A also exists
  in files B and C".
- **`branchPrefix()` is a per-walker-state function, not a per-task one.**
  Code that synthesises a branch name should ask "which task's branch?",
  not "which is the current prefix?". A helper named `branchForDep` makes
  the question explicit.

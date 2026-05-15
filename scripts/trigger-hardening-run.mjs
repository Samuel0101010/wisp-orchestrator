// One-shot script: build a hardening plan from a completed run's result
// branch findings and start a new run with chain_iteration=1 +
// parent_run_id=<that run>. Used to retroactively kick off the first
// Self-Healing iteration on a project whose previous successful run
// completed BEFORE v1.7.14 introduced the auto-chain hook.
//
// Usage:
//   node scripts/trigger-hardening-run.mjs <runId>
//
// The script talks to the local dashboard-server via HTTP — it does NOT
// touch the DB directly. That means the server's runtime hooks (auto-merge
// on subsequent success, self-healing chain extension) fire normally.

import { setTimeout as sleep } from 'node:timers/promises';

const RUN_ID = process.argv[2];
if (!RUN_ID) {
  console.error('usage: node scripts/trigger-hardening-run.mjs <runId>');
  process.exit(2);
}

const API = process.env.HARNESS_API ?? 'http://localhost:4400';

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

const runSnap = await api(`/api/runs/${RUN_ID}`);
const run = runSnap.run;
if (run.outcome !== 'success') {
  console.error(`run ${RUN_ID} did not succeed (outcome=${run.outcome}). aborting.`);
  process.exit(3);
}

const plan = await api(`/api/plans/${run.planId}`);
const project = await api(`/api/projects/${plan.projectId}`);

console.log(
  `[trigger-hardening] parent run=${RUN_ID} project=${project.name} (${project.id}) repo=${project.repoPath}`,
);

// Ask the server to build + start a hardening run on our behalf. We rely on
// the new POST /api/projects/:id/harden-run endpoint to do the plan
// construction + insert + startRun inside one transaction — it's the same
// path the self-healing chain uses internally.
const started = await api(`/api/projects/${project.id}/harden-run`, {
  method: 'POST',
  body: JSON.stringify({ parentRunId: RUN_ID }),
});
console.log('[trigger-hardening] started:', JSON.stringify(started, null, 2));

---
date: 2026-05-11
tags: [github-actions, ci, workflow-validation, secrets-context, opt-in-jobs]
files:
  - .github/workflows/ci.yml
related: []
---

# GitHub Actions silently rejects `secrets.*` in job-level `if:` — workflow registers 0 jobs

## Problem

After adding an opt-in `evals` job gated on a repo variable AND a secret being present, the first push to the branch returned a CI run that "completed/failure" in **0 seconds** with the message "This run likely failed because of a workflow file issue." `gh api .../jobs` returned `{"total_count": 0, "jobs": []}` — no jobs ran at all, not even `verify`.

The offending `if:` looked syntactically fine:

```yaml
if: ${{ vars.RUN_EVALS == 'true' && secrets.ANTHROPIC_API_KEY != '' }}
```

## Root cause

GitHub Actions validates workflows at the top level and **forbids `secrets.*` references in job-level `if:` conditions**. The expression evaluator that runs `if:` at job-scheduling time does not have access to the secrets context (secrets are only available to steps inside an already-scheduled job). When the validator sees `secrets.X` in an `if:`, it rejects the workflow file outright — and because the whole file is rejected, **every** job in it fails to register, not just the offending one.

There is no clear error surface for this. `gh run view` says "workflow file issue" without naming the file or line. You only find it by inspecting the `if:` expressions and noticing the `secrets.` reference.

## Solution

Drop the secret check from the job-level `if:`. Either:

1. Gate only on `vars.*` (repo variables) at the job level, and let the step inside the job fail with the provider-auth error if the secret is missing (promptfoo does this cleanly).
2. Move the secret-presence check into a step (`if: ${{ env.ANTHROPIC_API_KEY != '' }}` works inside a step that explicitly sets `env:` from `secrets:`).

We chose option 1 — simpler, and a missing `ANTHROPIC_API_KEY` is a configuration error worth surfacing loudly.

## Key snippets

```yaml
# .github/workflows/ci.yml
evals:
  name: evals
  runs-on: ubuntu-latest
  needs: verify
  # Opt-in: only runs when RUN_EVALS repo variable is set to "true".
  # GitHub Actions forbids secrets.* in job-level `if:` so the secret
  # cannot be gated here; the step itself will surface a clear
  # provider-auth error if ANTHROPIC_API_KEY is missing.
  if: ${{ vars.RUN_EVALS == 'true' }}
  steps:
    - run: pnpm eval
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Verification

- After the fix, the next push produced a CI run that registered all three jobs (`verify`, `e2e`, `evals`) instead of zero.
- `verify` proceeded and ran for 2m17s (vs. the previous 1m1s instant-fail with no jobs).
- `evals` shows status `skipping` because `vars.RUN_EVALS` is not set — exactly the desired opt-in behaviour.

## Lessons

- A workflow file with a `secrets.*` reference in a job-level `if:` looks valid in editors and on plain YAML parsing, but GitHub rejects the whole file at registration time. The cost is silent: no jobs run, no targeted error message.
- "Workflow file issue" + `total_count: 0 jobs` is the signature of a registration-time rejection, not a runtime failure. Look at `if:` conditions for forbidden contexts (`secrets.*`, possibly `env.*` depending on scope).
- For opt-in jobs that need both a repo variable AND a secret, gate on the variable at the job level and let the step's command fail clearly when the secret is empty. Don't try to pre-validate the secret presence — the step will surface it.
- Run `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs` whenever a CI run "fails" in 0 seconds — `total_count: 0` is the giveaway.

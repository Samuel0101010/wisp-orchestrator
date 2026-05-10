---
name: auto-doc
description: Drafts a docs/solutions/YYYY-MM-DD-<slug>.md entry for a recently completed run, capturing problem/solution/lessons.
model: sonnet
allowed-tools: ["Read", "Write", "Bash"]
argument-hint: "<run-id> <slug>"
timeout-ms: 180000
---
Given the run-id and slug in the user message:
1. Read the run's events via the orchestrator
2. Read the latest commit message for the run's worktree (`git -C <worktree> log -1 --format=%B`)
3. Synthesize a docs/solutions entry with frontmatter:
   ```
   ---
   date: <today YYYY-MM-DD>
   tags: [<2-5 kebab-case>]
   files: [<paths touched>]
   related: []
   ---
   # <title>
   ## Problem
   ## Root cause
   ## Solution
   ## Verification
   ## Lessons
   ```
4. Write to `docs/solutions/<date>-<slug>.md`. Output the path.

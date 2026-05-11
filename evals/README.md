# Agent Harness Eval Suite

Runs prompt regression tests against the seed skills + manager directives using
[promptfoo](https://www.promptfoo.dev/).

## Run

```
pnpm eval
```

Requires `ANTHROPIC_API_KEY` set in the environment.

## View results

```
pnpm eval:view
```

Opens a local web UI at http://localhost:15500.

## What's tested

| Case                           | Skill / Component     | What we assert                                                                                |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| `skill-deep-research.yaml`     | deep-research         | Output contains Summary, Key findings, Open questions sections                                |
| `skill-summarize-thread.yaml`  | summarize-thread      | Output contains all 5 required bullets                                                        |
| `skill-doctor.yaml`            | doctor                | Output is structured Pass/Fail with remediations                                              |
| `skill-audit-orphan-runs.yaml` | audit-orphan-runs     | Output lists orphans + cleanup commands; does NOT execute cleanup                             |
| `skill-auto-doc.yaml`          | auto-doc              | Output includes the docs/solutions frontmatter shape                                          |
| `manager-directives.yaml`      | manager system prompt | Manager produces correctly-formatted `<<ACTION>>{...}<<END>>` directives for canonical inputs |

## Adding a case

Each YAML file mirrors the skill's `SKILL.md` body as the prompt and lists 2-3
inputs with `assert:` rules. See `cases/skill-summarize-thread.yaml` for the template.

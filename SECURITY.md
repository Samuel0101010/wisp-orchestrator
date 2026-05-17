# Security Policy

WISP takes the security of its orchestrator, plugin runtime, and data-handling surfaces seriously. This document describes which versions receive security updates, how to report a vulnerability, what is in scope, and how disclosure is coordinated.

## Supported Versions

Only the latest minor release line receives security fixes. Older lines are end-of-life and will not receive backports.

| Version | Status         |
| ------- | -------------- |
| 2.0.x   | Supported      |
| 1.x     | No longer supported  |
| < 1.0   | No longer supported  |

If you are running an unsupported version, upgrade to the latest 2.0.x release before reporting an issue.

## Reporting a Vulnerability

The preferred channel is **GitHub Private Vulnerability Reporting**:

- Open a private advisory: https://github.com/Samuel0101010/wisp-orchestrator/security/advisories/new

For **non-critical** findings (hardening suggestions, minor information disclosure with no exploit path), a public GitHub issue with the `security` label is acceptable:

- https://github.com/Samuel0101010/wisp-orchestrator/issues/new?labels=security

Please do **not** disclose details on public channels (issues, discussions, social media) until a coordinated disclosure window has been agreed. The maintainer will reach out privately via GitHub once the advisory is filed.

When reporting, please include:

- Affected version(s) and platform.
- A minimal reproduction or proof-of-concept.
- Observed impact and any known mitigations.
- Whether you intend to publish a write-up, and any preferred attribution.

## Response SLA

| Stage                       | Target                                 |
| --------------------------- | -------------------------------------- |
| Initial response            | Within 7 days of report                |
| Triage and patch ETA shared | Within 14 days of report               |
| Public disclosure           | Coordinated with reporter (see below)  |

If you have not received a response within 7 days, please re-ping by opening a follow-up advisory referencing the original report.

## Scope

The following are considered in-scope security issues:

- Remote or local **code execution** via the orchestrator (e.g. unsafe deserialization, command injection in task subprocesses).
- **Authentication or authorization bypass** on the dashboard server or any privileged HTTP endpoint.
- **Path traversal** or unsafe path resolution in `WISP_DATA_DIR` handling, worktree management, or artifact storage.
- **Plugin manifest injection** or unsafe parsing leading to privilege escalation or arbitrary file write.
- Secret leakage from logs, event streams, or persisted run state.
- Sandbox escapes from agent-executed subprocesses into the host shell beyond declared permissions.

The following are **not** in scope:

- Denial-of-service via goal spam, queue flooding, or resource exhaustion on a self-hosted instance — operators are expected to rate-limit their own deployments.
- Dependency CVEs without a demonstrated exploit path against WISP itself — please allow Dependabot to handle these in the normal update cycle.
- Findings against unsupported versions (see Supported Versions).
- Social engineering, physical access attacks, or attacks requiring a pre-compromised host.
- Issues that require the attacker to already control the WISP configuration or `settings.json`.

## Disclosure Policy

WISP follows **coordinated disclosure**:

- A 90-day disclosure window from the initial report is preferred.
- The window may be shortened if a patch ships earlier, or extended by mutual agreement if the fix is non-trivial.
- A CVE will be requested via GitHub Security Advisories where the issue meets CVE criteria.
- Reporters will be credited in the advisory and release notes unless they prefer to remain anonymous.

## Acknowledgements

We thank the following researchers for responsibly disclosing security issues in WISP:

- _(none yet — your name could go here)_

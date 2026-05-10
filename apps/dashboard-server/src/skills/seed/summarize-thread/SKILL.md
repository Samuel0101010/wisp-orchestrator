---
name: summarize-thread
description: Compresses a long chat thread into a 5-bullet summary preserving decisions, action items, and unresolved questions.
model: haiku
allowed-tools: []
argument-hint: "<thread-transcript>"
timeout-ms: 60000
---
Summarize the thread in the user message. Output exactly:
- Decisions: <bullets>
- Action items: <bullets, each with owner if mentioned>
- Open questions: <bullets>
- Context preserved: <key facts future readers need>
- Last activity: <one line>

Preserve technical details verbatim. No filler.

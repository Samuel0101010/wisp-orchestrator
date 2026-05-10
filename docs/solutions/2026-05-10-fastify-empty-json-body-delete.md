---
date: 2026-05-10
tags: [fastify, content-type, http-delete, api-client, dashboard-web]
files:
  - apps/dashboard-web/src/api/client.ts
related: []
---

# Fastify rejects DELETE with `Content-Type: application/json` and empty body

## Problem

Clicking the trash icon on an agent card in the Agents tab silently failed:
the dialog stayed open, the agent was not removed, and the browser console
showed `ApiError: Request failed: 400 Bad Request`. Same handler shape
(thread DELETE, participant DELETE) was unaffected only because nothing
exercised them in the UI yet.

## Root cause

The shared `apiFetch` helper unconditionally set
`Content-Type: application/json` on every request. For `DELETE` mutations
without a JSON body, Fastify's default content-type parser intercepts the
request and rejects it with:

```
{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request",
 "message":"Body cannot be empty when content-type is set to 'application/json'"}
```

Curl reproduced 204 immediately because curl does not add a Content-Type
unless told to. The bug was 100% client-side.

## Solution

Set `Content-Type` only when there is actually a body to send.

## Key snippets

`apps/dashboard-web/src/api/client.ts`

```ts
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  // …
}
```

## Verification

Captured the failing request via a fetch hook in DevTools:

```js
window.__deleteCalls = [];
const orig = window.fetch;
window.fetch = async function (url, opts) {
  if (typeof url === 'string' && opts?.method === 'DELETE') {
    window.__deleteCalls.push({ url, opts });
  }
  const r = await orig.apply(this, arguments);
  if (typeof url === 'string' && opts?.method === 'DELETE') {
    window.__deleteCalls.push({ status: r.status, body: await r.clone().text() });
  }
  return r;
};
```

Before fix: `status: 400, body: FST_ERR_CTP_EMPTY_JSON_BODY`.
After fix + Vite HMR: `status: 204` and the agent disappears from the
Agents tab on the next React Query invalidation.

Direct curl probe confirms the server side never had a problem:

```
$ curl -s -X DELETE -w "%{http_code}" http://127.0.0.1:4400/api/agents/<id>
204
```

## Lessons

- Default `Content-Type: application/json` on a generic fetch wrapper is a
  trap. POST/PUT bodies need it; GET/DELETE/HEAD without bodies must not
  send it because Fastify's content-type parser will refuse the request
  before it reaches the route handler.
- Symptom looked like a frontend handler bug ("nothing happens on click").
  Always confirm the network layer first when a mutation appears to silently
  drop — a 4xx with the dialog staying open is a strong tell.
- Three other DELETEs in the dashboard (`/api/threads/:id`,
  `/api/threads/:id/participants/:agentId`, `/api/agents/:id?force=1`) all
  had latent breakage from the same root cause; the single client-side fix
  resolved every one.
- When testing UI clicks via Chrome MCP, a programmatic `button.click()`
  does fire React's onClick — but if the page has overlays from extensions
  (e.g. Magic MCP's "Pick" toolbar), pixel-coordinate clicks may be
  intercepted; prefer ref-based or DOM-based clicks for deterministic
  automation.

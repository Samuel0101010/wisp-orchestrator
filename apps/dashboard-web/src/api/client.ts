export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when there's actually a JSON body. Fastify rejects
  // requests like `DELETE` with an empty body if the header claims JSON
  // (FST_ERR_CTP_EMPTY_JSON_BODY). For FormData, leave Content-Type unset so
  // the browser fills in the multipart boundary.
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const hasJsonBody = init?.body != null && !isFormData;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    throw new ApiError(res.status, `Request failed: ${res.status} ${res.statusText}`, body);
  }
  // 204 → no JSON body
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type { HarnessEvent, Plan, Project, Team, AgentSpec, Role } from '@wisp/schemas';

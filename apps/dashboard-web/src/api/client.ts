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
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
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

export type { HarnessEvent, Plan, Project, Team, AgentSpec, Role } from '@agent-harness/schemas';

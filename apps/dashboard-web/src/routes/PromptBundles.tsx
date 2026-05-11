import { usePromptBundles, useDeletePromptBundle } from '@/api/queries';

export function PromptBundlesRoute() {
  const q = usePromptBundles();
  const del = useDeletePromptBundle();

  if (q.isLoading) return <div className="text-muted-foreground">Loading…</div>;
  if (q.error) return <div className="text-destructive">Failed to load</div>;
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Prompt-Bundle Cache</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} cached bundle{rows.length === 1 ? '' : 's'}. Each row is a stable cwd +
          Claude session for a unique (system-prompt, tools, model) combo.
        </p>
      </header>
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No bundles cached yet. Invoke a skill to populate.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th>Bundle key</th>
              <th>Model</th>
              <th>Session</th>
              <th>Hits</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bundleKey} className="border-t border-border">
                <td className="py-1 pr-3 font-mono text-xs">{r.bundleKey.slice(0, 12)}…</td>
                <td className="py-1 pr-3 font-mono">{r.model}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.claudeSessionId ?? '—'}</td>
                <td className="py-1 pr-3">{r.hitCount}</td>
                <td className="py-1 pr-3">{new Date(r.lastUsedAt).toLocaleString()}</td>
                <td className="py-1 pr-3">
                  <button
                    onClick={() => del.mutate(r.bundleKey)}
                    className="text-destructive hover:underline"
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

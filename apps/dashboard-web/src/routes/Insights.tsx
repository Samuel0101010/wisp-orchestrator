import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/api/client';

interface TrajectoryRow {
  id: string;
  projectId: string | null;
  prompt: string;
  outcome: string;
  lessons: string | null;
  tokensTotal: number;
  createdAt: string | number;
}
interface PriorRow {
  role: string;
  model: string;
  alpha: number;
  beta: number;
  mean: number;
  samples: number;
}

export function InsightsRoute() {
  const trajQ = useQuery<TrajectoryRow[]>({
    queryKey: ['insights', 'trajectories'],
    queryFn: () => apiFetch('/api/insights/trajectories'),
  });
  const priorsQ = useQuery<PriorRow[]>({
    queryKey: ['insights', 'router-priors'],
    queryFn: () => apiFetch('/api/insights/router-priors'),
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Insights</h1>
        <p className="text-sm text-muted-foreground">Past trajectories and model router priors.</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Past trajectories</h2>
        {trajQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : trajQ.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trajectories yet. Complete a run to record one.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th>When</th>
                <th>Outcome</th>
                <th>Prompt</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {trajQ.data?.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="py-1 pr-3">{new Date(t.createdAt).toLocaleString()}</td>
                  <td className="py-1 pr-3">
                    <span
                      className={t.outcome === 'success' ? 'text-emerald-500' : 'text-destructive'}
                    >
                      {t.outcome}
                    </span>
                  </td>
                  <td className="py-1 pr-3 truncate max-w-md">{t.prompt}</td>
                  <td className="py-1 pr-3 font-mono">{t.tokensTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Model router priors</h2>
        {priorsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : priorsQ.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No samples yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th>Role</th>
                <th>Model</th>
                <th>α</th>
                <th>β</th>
                <th>Mean</th>
                <th>Samples</th>
              </tr>
            </thead>
            <tbody>
              {priorsQ.data?.map((p) => (
                <tr key={`${p.role}-${p.model}`} className="border-t border-border">
                  <td className="py-1 pr-3 font-mono">{p.role}</td>
                  <td className="py-1 pr-3 font-mono">{p.model}</td>
                  <td className="py-1 pr-3">{p.alpha.toFixed(2)}</td>
                  <td className="py-1 pr-3">{p.beta.toFixed(2)}</td>
                  <td className="py-1 pr-3">{p.mean.toFixed(3)}</td>
                  <td className="py-1 pr-3">{p.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

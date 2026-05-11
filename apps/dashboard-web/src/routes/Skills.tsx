import { useMemo, useState } from 'react';
import { useSkills, useReloadSkills } from '@/api/queries';

type SourceFilter = 'all' | 'seed' | 'project' | 'user' | 'plugin';

function sourceBucket(source: string): Exclude<SourceFilter, 'all'> {
  if (source.startsWith('plugin:')) return 'plugin';
  if (source === 'project' || source === 'user' || source === 'seed') return source;
  return 'seed';
}

function sourceBadgeClasses(source: string): string {
  // Tailwind palette per origin so a glance at the page reveals provenance.
  if (source === 'seed') return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
  if (source === 'project') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (source === 'user') return 'bg-amber-500/15 text-amber-800 dark:text-amber-300';
  return 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300';
}

export function SkillsRoute() {
  const skillsQ = useSkills();
  const reload = useReloadSkills();
  const [filter, setFilter] = useState<SourceFilter>('all');

  const skills = useMemo(() => skillsQ.data ?? [], [skillsQ.data]);
  const counts = useMemo(() => {
    const c = { all: skills.length, seed: 0, project: 0, user: 0, plugin: 0 };
    for (const s of skills) c[sourceBucket(s.source)] += 1;
    return c;
  }, [skills]);
  const visible =
    filter === 'all' ? skills : skills.filter((s) => sourceBucket(s.source) === filter);

  if (skillsQ.isLoading) return <div className="text-muted-foreground">Loading skills…</div>;
  if (skillsQ.error) return <div className="text-destructive">Failed to load skills</div>;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? '' : 's'} discovered across seed, project,
            user, and plugin sources
          </p>
        </div>
        <button
          onClick={() => reload.mutate()}
          disabled={reload.isPending}
          className="rounded border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {reload.isPending ? 'Reloading…' : 'Reload from disk'}
        </button>
      </header>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {(['all', 'seed', 'project', 'user', 'plugin'] as SourceFilter[]).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={
              'rounded border px-2.5 py-1 transition ' +
              (filter === key
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-card hover:bg-accent')
            }
          >
            {key} <span className="ml-1 opacity-60">{counts[key]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {skills.length === 0
            ? 'No skills found. Add SKILL.md files under apps/dashboard-server/src/skills/seed/, .claude/skills/, or ~/.claude/skills/.'
            : `No skills with source = ${filter}.`}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((s) => (
            <li key={`${s.source}::${s.name}`} className="rounded border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-mono text-base font-semibold">{s.name}</h3>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${sourceBadgeClasses(s.source)}`}
                  >
                    {s.source}
                  </span>
                  <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium uppercase text-secondary-foreground">
                    {s.model}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
              {s.argumentHint && (
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  args: {s.argumentHint}
                </p>
              )}
              {s.allowedTools.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {s.allowedTools.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

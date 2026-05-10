import { useSkills, useReloadSkills } from '@/api/queries';

export function SkillsRoute() {
  const skillsQ = useSkills();
  const reload = useReloadSkills();

  if (skillsQ.isLoading) return <div className="text-muted-foreground">Loading skills…</div>;
  if (skillsQ.error) return <div className="text-destructive">Failed to load skills</div>;
  const skills = skillsQ.data ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? '' : 's'} loaded from disk
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

      {skills.length === 0 ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No skills found. Add SKILL.md files under apps/dashboard-server/src/skills/seed/
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {skills.map((s) => (
            <li key={s.name} className="rounded border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-mono text-base font-semibold">{s.name}</h3>
                <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium uppercase text-secondary-foreground">
                  {s.model}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
              {s.argumentHint && (
                <p className="mt-2 font-mono text-xs text-muted-foreground">args: {s.argumentHint}</p>
              )}
              {s.allowedTools.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {s.allowedTools.map((t) => (
                    <span key={t} className="rounded border border-border px-1.5 py-0.5 font-mono text-xs">
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

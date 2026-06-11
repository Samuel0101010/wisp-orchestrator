import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Asterisk, X } from 'lucide-react';
import { useSkills } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** Mirrors agentSpecSchema.skills max — keep in sync with packages/schemas. */
const MAX_SKILLS = 8;

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  /** Stable id for the Label `htmlFor` association. */
  id?: string;
  /** Test seam — open the picker by default in tests. */
  initialOpen?: boolean;
}

/**
 * Per-role skill picker for the Team Builder. Options come from the harness
 * skill registry (GET /api/skills). Names not in the registry (e.g. a team
 * imported from a machine with more skills installed) still render as
 * removable chips with an asterisk marker — the orchestrator skips unknown
 * names at dispatch, so they're harmless but visible.
 */
export function SkillMultiSelect({ value, onChange, id, initialOpen = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const skillsQ = useSkills();
  // Defensive: tolerate a non-array payload (e.g. blanket-mocked fetch in
  // tests or an API error body) instead of crashing the Team Builder.
  const available = Array.isArray(skillsQ.data) ? skillsQ.data : [];
  const knownNames = useMemo(() => new Set(available.map((s) => s.name)), [available]);
  const selected = useMemo(() => new Set(value), [value]);
  const atLimit = value.length >= MAX_SKILLS;

  const toggle = (name: string): void => {
    if (selected.has(name)) onChange(value.filter((v) => v !== name));
    else if (!atLimit) onChange([...value, name]);
  };

  const remove = (name: string): void => {
    onChange(value.filter((v) => v !== name));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="skill-multiselect">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {value.length === 0
            ? t('skillMultiSelect.noneSelected')
            : t('skillMultiSelect.selected', { count: value.length })}
        </span>
        <div className="ml-auto">
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen((o) => !o)}
            data-testid="skill-multiselect-toggle"
          >
            {open ? t('skillMultiSelect.hide') : t('skillMultiSelect.pick')}
          </Button>
        </div>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((name) => {
            const unknown = skillsQ.isSuccess && !knownNames.has(name);
            return (
              <Badge
                key={name}
                variant={unknown ? 'secondary' : 'default'}
                className="inline-flex items-center gap-1 pr-1"
                data-testid={`skill-chip-${name}`}
              >
                {unknown && (
                  <Asterisk
                    role="img"
                    className="size-3 shrink-0"
                    aria-label={t('skillMultiSelect.unknownMarker')}
                  />
                )}
                <span>{name}</span>
                <button
                  type="button"
                  onClick={() => remove(name)}
                  aria-label={t('skillMultiSelect.removeAria', { name })}
                  className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`skill-chip-remove-${name}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
      {open && (
        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-md border bg-card p-3">
          {available.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('skillMultiSelect.empty')}</p>
          )}
          {available.map((s) => {
            const checked = selected.has(s.name);
            return (
              <label key={s.name} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atLimit}
                  onChange={() => toggle(s.name)}
                  className="mt-1"
                  data-testid={`skill-cb-${s.name}`}
                />
                <span className="flex-1">
                  <code className="text-xs">{s.name}</code>
                  <span className="ml-2 text-xs text-muted-foreground">{s.description}</span>
                </span>
              </label>
            );
          })}
          {atLimit && (
            <p className="text-xs text-amber-500">
              {t('skillMultiSelect.limit', { count: MAX_SKILLS })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

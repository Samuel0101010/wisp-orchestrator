import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTemplates, type TeamTemplate } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Clock, Layers } from 'lucide-react';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const COMPLEXITY_TONE: Record<NonNullable<TeamTemplate['complexity']>, string> = {
  simple: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  complex: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
};

export function TemplatePicker({ selectedId, onSelect }: Props) {
  const { t } = useTranslation();
  const { data: templates = [], isLoading, error } = useTemplates();

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">{t('templatePicker.loading')}</p>;
  }
  if (error) {
    return (
      <p className="text-xs text-destructive">
        {t('templatePicker.loadFailed', { message: error.message })}
      </p>
    );
  }

  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        data-testid="template-pick-none"
        className={
          'rounded-md border p-3 text-left text-xs transition-colors ' +
          (selectedId === null
            ? 'border-primary bg-accent text-accent-foreground'
            : 'border-input hover:bg-accent')
        }
      >
        <div className="font-medium">{t('templatePicker.noTemplate')}</div>
        <div className="text-muted-foreground">{t('templatePicker.noTemplateHint')}</div>
      </button>
      {templates.map((tpl) => (
        <TemplateCard
          key={tpl.id}
          template={tpl}
          selected={selectedId === tpl.id}
          onSelect={() => onSelect(tpl.id)}
        />
      ))}
    </div>
  );
}

interface CardProps {
  template: TeamTemplate;
  selected: boolean;
  onSelect: () => void;
}

function TemplateCard({ template, selected, onSelect }: CardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasRichInfo =
    Boolean(template.useCases?.length) ||
    Boolean(template.bestFor?.length) ||
    Boolean(template.notRecommendedFor?.length);

  return (
    <div
      className={
        'rounded-md border transition-colors ' +
        (selected ? 'border-primary bg-accent text-accent-foreground' : 'border-input')
      }
    >
      <button
        type="button"
        onClick={onSelect}
        data-testid={`template-pick-${template.id}`}
        className={'w-full p-3 text-left transition-colors ' + (selected ? '' : 'hover:bg-accent')}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{template.name}</span>
          <Badge variant="secondary" className="text-[10px]">
            {t('templatePicker.rolesCount', { count: template.team.roles.length })}
          </Badge>
          {template.complexity && (
            <Badge
              variant="secondary"
              className={`text-[10px] ${COMPLEXITY_TONE[template.complexity]}`}
              title={t('templatePicker.complexity.label')}
            >
              <Layers className="mr-1 inline h-3 w-3" />
              {t(`templatePicker.complexity.${template.complexity}`)}
            </Badge>
          )}
          {template.expectedDurationMinutes !== undefined && (
            <Badge variant="outline" className="text-[10px]">
              <Clock className="mr-1 inline h-3 w-3" />
              {t('templatePicker.duration', { minutes: template.expectedDurationMinutes })}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
      </button>
      {hasRichInfo && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="flex w-full items-center justify-center gap-1 border-t px-3 py-1 text-[10px] uppercase text-muted-foreground hover:bg-accent"
          data-testid={`template-expand-${template.id}`}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> {t('templatePicker.collapse')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> {t('templatePicker.expand')}
            </>
          )}
        </button>
      )}
      {hasRichInfo && expanded && (
        <div className="space-y-2 border-t p-3 text-xs">
          {template.useCases && template.useCases.length > 0 && (
            <Section title={t('templatePicker.useCases')} items={template.useCases} />
          )}
          {template.bestFor && template.bestFor.length > 0 && (
            <Section title={t('templatePicker.bestFor')} items={template.bestFor} />
          )}
          {template.notRecommendedFor && template.notRecommendedFor.length > 0 && (
            <Section
              title={t('templatePicker.notRecommendedFor')}
              items={template.notRecommendedFor}
              tone="muted"
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  items,
  tone = 'normal',
}: {
  title: string;
  items: string[];
  tone?: 'normal' | 'muted';
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul
        className={`list-disc space-y-0.5 pl-4 ${tone === 'muted' ? 'text-muted-foreground/80' : ''}`}
      >
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

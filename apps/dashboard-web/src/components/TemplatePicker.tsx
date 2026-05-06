import { useTemplates, type TeamTemplate } from '@/api/queries';
import { Badge } from '@/components/ui/badge';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function TemplatePicker({ selectedId, onSelect }: Props) {
  const { data: templates = [], isLoading, error } = useTemplates();

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading templates…</p>;
  }
  if (error) {
    return <p className="text-xs text-destructive">Could not load templates: {error.message}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
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
        <div className="font-medium">No template</div>
        <div className="text-muted-foreground">
          Start with the default 3-role team and write your own goal.
        </div>
      </button>
      {templates.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          selected={selectedId === t.id}
          onSelect={() => onSelect(t.id)}
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
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`template-pick-${template.id}`}
      className={
        'rounded-md border p-3 text-left transition-colors ' +
        (selected
          ? 'border-primary bg-accent text-accent-foreground'
          : 'border-input hover:bg-accent')
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{template.name}</span>
        <Badge variant="secondary" className="text-[10px]">
          {template.team.roles.length} roles
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
    </button>
  );
}

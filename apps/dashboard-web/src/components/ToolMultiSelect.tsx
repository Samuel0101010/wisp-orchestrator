import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ALL_CATALOG_TOOL_NAMES, TOOL_CATALOG } from '@/data/toolCatalog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  /** Stable id for the Label `htmlFor` association. */
  id?: string;
  /** Test seam — open the picker by default in tests. */
  initialOpen?: boolean;
}

/**
 * Replaces the comma-separated text input for `allowedTools`. Renders the
 * known tools as grouped checkboxes with descriptions, plus a custom-pattern
 * field for entries (typically Bash globs) not in the catalog. Custom entries
 * round-trip through `value` so the user can see and remove typo'd patterns
 * instead of discovering them only at runtime.
 */
export function ToolMultiSelect({ value, onChange, id, initialOpen = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const [customInput, setCustomInput] = useState('');

  const selected = useMemo(() => new Set(value), [value]);
  const customTools = useMemo(() => value.filter((v) => !ALL_CATALOG_TOOL_NAMES.has(v)), [value]);

  const toggle = (name: string): void => {
    if (selected.has(name)) onChange(value.filter((v) => v !== name));
    else onChange([...value, name]);
  };

  const addCustom = (): void => {
    const trimmed = customInput.trim();
    if (!trimmed || selected.has(trimmed)) return;
    onChange([...value, trimmed]);
    setCustomInput('');
  };

  const remove = (name: string): void => {
    onChange(value.filter((v) => v !== name));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="tool-multiselect">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {value.length === 0
            ? t('toolMultiSelect.noneSelected')
            : t('toolMultiSelect.selected', { count: value.length })}
        </span>
        <div className="ml-auto">
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen((o) => !o)}
            data-testid="tool-multiselect-toggle"
          >
            {open ? t('toolMultiSelect.hide') : t('toolMultiSelect.pick')}
          </Button>
        </div>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((t) => {
            const isCustom = !ALL_CATALOG_TOOL_NAMES.has(t);
            return (
              <Badge
                key={t}
                variant={isCustom ? 'secondary' : 'default'}
                className="cursor-pointer"
                onClick={() => remove(t)}
                title={isCustom ? 'Custom — click to remove' : 'Click to remove'}
                data-testid={`tool-chip-${t}`}
              >
                {t} ×
              </Badge>
            );
          })}
        </div>
      )}
      {open && (
        <div className="flex max-h-80 flex-col gap-3 overflow-y-auto rounded-md border bg-card p-3">
          {TOOL_CATALOG.map((cat) => (
            <div key={cat.id} className="flex flex-col gap-1.5">
              <div>
                <p className="text-sm font-medium">{cat.title}</p>
                <p className="text-xs text-muted-foreground">{cat.description}</p>
              </div>
              <div className="flex flex-col gap-1">
                {cat.tools.map((t) => (
                  <label key={t.name} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(t.name)}
                      onChange={() => toggle(t.name)}
                      className="mt-1"
                      data-testid={`tool-cb-${t.name}`}
                    />
                    <span className="flex-1">
                      <code className="text-xs">{t.name}</code>
                      <span className="ml-2 text-xs text-muted-foreground">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="border-t pt-3">
            <Label className="text-xs">Custom pattern</Label>
            <p className="mb-1 text-xs text-muted-foreground">
              Add any tool name not in the catalog (e.g. <code>Bash(make:*)</code>).
            </p>
            <div className="flex gap-2">
              <Input
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="Bash(custom:*)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                data-testid="tool-multiselect-custom-input"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addCustom}
                data-testid="tool-multiselect-custom-add"
              >
                Add
              </Button>
            </div>
            {customTools.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {customTools.length} custom tool{customTools.length === 1 ? '' : 's'} — shown as a
                secondary badge above. Click any badge to remove.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

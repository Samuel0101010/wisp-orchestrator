import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentSpec } from '@wisp/schemas';
import { ToolMultiSelect } from '@/components/ToolMultiSelect';
import { SnippetMenu } from '@/components/SnippetMenu';
import { MODEL_INFO, MODEL_LIST } from '@/data/modelInfo';

export const SYSTEM_PROMPT_MIN = 50;
export const SYSTEM_PROMPT_MAX = 4000;
const SYSTEM_PROMPT_WARN = 3500;

export interface DraftAgent {
  role: string;
  model: AgentSpec['model'];
  /**
   * Array form (post-v1.1). The legacy comma-separated text form lived in
   * `allowedToolsText` and was error-prone — typos would silently fail at
   * runtime. ToolMultiSelect produces canonical strings directly.
   */
  allowedTools: string[];
  systemPrompt: string;
}

const ROLE_REGEX = /^[a-z][a-z0-9-]*$/;

export function isRoleNameValid(role: string): boolean {
  return role.length >= 2 && role.length <= 40 && ROLE_REGEX.test(role);
}

/**
 * Drag handle props produced by `useSortable` from @dnd-kit. Threaded through
 * so the SortableTeamRoleCard wrapper can wire only the grip button as the
 * drag activator, leaving the rest of the card interactive.
 */
export interface DragHandleProps {
  /** Forwarded ref from `useSortable.setActivatorNodeRef`. */
  ref?: (node: HTMLElement | null) => void;
  /** Spread of `useSortable.attributes` + `useSortable.listeners`. */
  [key: string]: unknown;
}

interface TeamRoleCardProps {
  draft: DraftAgent;
  index: number;
  onChange: (next: DraftAgent) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isDuplicate: boolean;
  /** When provided, renders a "Test prompt" button that opens the dialog. */
  onTestPrompt?: () => void;
  /** When provided, renders the drag-handle grip wired to dnd-kit. */
  dragHandleProps?: DragHandleProps;
}

export function TeamRoleCard({
  draft,
  index,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canRemove,
  canMoveUp,
  canMoveDown,
  isDuplicate,
  onTestPrompt,
  dragHandleProps,
}: TeamRoleCardProps) {
  const { t } = useTranslation();
  const promptLen = draft.systemPrompt.length;
  const promptShort = promptLen < SYSTEM_PROMPT_MIN;
  const promptOver = promptLen > SYSTEM_PROMPT_MAX;
  const promptWarn = !promptShort && !promptOver && promptLen >= SYSTEM_PROMPT_WARN;
  const roleInvalid = draft.role !== '' && !isRoleNameValid(draft.role);
  const displayTitle = draft.role || t('teamRoleCard.newRole');
  const modelInfo = MODEL_INFO[draft.model];

  const lengthClass = promptOver
    ? 'text-xs text-destructive'
    : promptShort
      ? 'text-xs text-destructive'
      : promptWarn
        ? 'text-xs text-amber-500'
        : 'text-xs text-muted-foreground';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="min-w-0 flex-1 truncate sm:overflow-visible sm:whitespace-normal">
            {displayTitle}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            {dragHandleProps && (
              <button
                type="button"
                {...dragHandleProps}
                className="inline-flex h-9 w-7 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t('teamRoleCard.drag')}
                aria-label="Drag handle"
                data-testid={`drag-handle-${index}`}
              >
                <GripVertical className="h-4 w-4" />
              </button>
            )}
            <Badge variant="secondary" data-testid={`badge-${draft.role}`}>
              {draft.model}
            </Badge>
            <IconButton
              label={t('tooltips.moveRoleUp')}
              icon={<ArrowUp className="h-4 w-4" />}
              onClick={onMoveUp}
              disabled={!canMoveUp || !onMoveUp}
              data-testid={`move-up-${index}`}
            />
            <IconButton
              label={t('tooltips.moveRoleDown')}
              icon={<ArrowDown className="h-4 w-4" />}
              onClick={onMoveDown}
              disabled={!canMoveDown || !onMoveDown}
              data-testid={`move-down-${index}`}
            />
            <IconButton
              label={t('tooltips.removeRole')}
              icon={<X className="h-4 w-4" />}
              onClick={onRemove}
              disabled={!canRemove}
              data-testid={`remove-${draft.role}`}
            />
          </div>
        </div>
        <CardDescription>{t('teamRoleCard.describe', { name: displayTitle })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`role-${index}`}>{t('teamRoleCard.fields.role')}</Label>
          <Input
            id={`role-${index}`}
            data-testid={`role-name-${index}`}
            placeholder={t('teamRoleCard.fields.rolePlaceholder')}
            value={draft.role}
            onChange={(e) => onChange({ ...draft, role: e.target.value })}
            className={roleInvalid ? 'border-destructive' : undefined}
          />
          {roleInvalid && (
            <p className="text-xs text-destructive">{t('teamRoleCard.fields.roleInvalid')}</p>
          )}
          {isDuplicate && (
            <p className="text-xs text-destructive">{t('teamRoleCard.fields.roleDuplicate')}</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`model-${index}`}>{t('teamRoleCard.fields.model')}</Label>
          <select
            id={`model-${index}`}
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value as DraftAgent['model'] })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            data-testid={`model-${draft.role}`}
          >
            {MODEL_LIST.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name.toLowerCase()} — {t(`modelInfo.costClass.${m.costClass}`)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground" data-testid={`model-hint-${index}`}>
            {t(`modelInfo.notes.${draft.model}`, { defaultValue: modelInfo.notes })}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`tools-${index}`}>{t('teamRoleCard.fields.tools')}</Label>
          <p className="text-xs text-muted-foreground">{t('teamRoleCard.fields.toolsHint')}</p>
          <ToolMultiSelect
            id={`tools-${index}`}
            value={draft.allowedTools}
            onChange={(next) => onChange({ ...draft, allowedTools: next })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`prompt-${index}`}>{t('teamRoleCard.fields.systemPrompt')}</Label>
            <SnippetMenu
              onInsert={(s) => {
                const sep = draft.systemPrompt.length === 0 ? '' : '\n\n';
                onChange({ ...draft, systemPrompt: draft.systemPrompt + sep + s.body });
              }}
            />
          </div>
          <Textarea
            id={`prompt-${index}`}
            rows={10}
            value={draft.systemPrompt}
            onChange={(e) => onChange({ ...draft, systemPrompt: e.target.value })}
          />
          <p className={lengthClass} data-testid={`prompt-count-${draft.role}`}>
            {promptOver
              ? t('teamRoleCard.promptCount.over', { count: promptLen })
              : promptShort
                ? t('teamRoleCard.promptCount.tooShort', { count: promptLen })
                : promptWarn
                  ? t('teamRoleCard.promptCount.warn', { count: promptLen })
                  : t('teamRoleCard.promptCount.ok', { count: promptLen })}
          </p>
        </div>
        {onTestPrompt && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTestPrompt}
              data-testid={`test-prompt-${index}`}
            >
              {t('teamRoleCard.testPrompt')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

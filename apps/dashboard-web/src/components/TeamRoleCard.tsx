import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentSpec } from '@agent-harness/schemas';
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
}: TeamRoleCardProps) {
  const promptLen = draft.systemPrompt.length;
  const promptShort = promptLen < SYSTEM_PROMPT_MIN;
  const promptOver = promptLen > SYSTEM_PROMPT_MAX;
  const promptWarn = !promptShort && !promptOver && promptLen >= SYSTEM_PROMPT_WARN;
  const roleInvalid = draft.role !== '' && !isRoleNameValid(draft.role);
  const displayTitle = draft.role || '(new role)';
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
          <CardTitle className="truncate">{displayTitle}</CardTitle>
          <div className="flex items-center gap-1">
            <Badge variant="secondary" data-testid={`badge-${draft.role}`}>
              {draft.model}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMoveUp}
              disabled={!canMoveUp || !onMoveUp}
              title="Move up"
              data-testid={`move-up-${index}`}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMoveDown}
              disabled={!canMoveDown || !onMoveDown}
              title="Move down"
              data-testid={`move-down-${index}`}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={!canRemove}
              data-testid={`remove-${draft.role}`}
            >
              Remove
            </Button>
          </div>
        </div>
        <CardDescription>Configure the {displayTitle} agent.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`role-${index}`}>Role name</Label>
          <Input
            id={`role-${index}`}
            data-testid={`role-name-${index}`}
            placeholder="kebab-case-name"
            value={draft.role}
            onChange={(e) => onChange({ ...draft, role: e.target.value })}
            className={roleInvalid ? 'border-destructive' : undefined}
          />
          {roleInvalid && (
            <p className="text-xs text-destructive">kebab-case identifier (a-z, 0-9, -)</p>
          )}
          {isDuplicate && <p className="text-xs text-destructive">duplicate role name</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`model-${index}`}>Model</Label>
          <select
            id={`model-${index}`}
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value as DraftAgent['model'] })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            data-testid={`model-${draft.role}`}
          >
            {MODEL_LIST.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name.toLowerCase()} — {m.costClass}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground" data-testid={`model-hint-${index}`}>
            {modelInfo.notes}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`tools-${index}`}>Allowed tools</Label>
          <p className="text-xs text-muted-foreground">
            Restrict what this agent can call. Leave empty to grant Claude Code defaults.
          </p>
          <ToolMultiSelect
            id={`tools-${index}`}
            value={draft.allowedTools}
            onChange={(next) => onChange({ ...draft, allowedTools: next })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`prompt-${index}`}>System prompt</Label>
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
            {promptLen} / {SYSTEM_PROMPT_MAX} characters
            {promptShort ? ` (min ${SYSTEM_PROMPT_MIN})` : ''}
            {promptOver ? ' — over limit, save will fail' : ''}
            {promptWarn ? ' — approaching limit' : ''}
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
              Test this prompt…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

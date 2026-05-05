import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentSpec } from '@agent-harness/schemas';

export const SYSTEM_PROMPT_MIN = 50;

export interface DraftAgent {
  role: string;
  model: AgentSpec['model']; // 'opus' | 'sonnet' | 'haiku'
  allowedToolsText: string;
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
  canRemove: boolean;
  isDuplicate: boolean;
}

export function TeamRoleCard({
  draft,
  index,
  onChange,
  onRemove,
  canRemove,
  isDuplicate,
}: TeamRoleCardProps) {
  const promptLen = draft.systemPrompt.length;
  const promptShort = promptLen < SYSTEM_PROMPT_MIN;
  const roleInvalid = draft.role !== '' && !isRoleNameValid(draft.role);
  const displayTitle = draft.role || '(new role)';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{displayTitle}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid={`badge-${draft.role}`}>
              {draft.model}
            </Badge>
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
            disabled={!canRemove}
            onChange={(e) => onChange({ ...draft, role: e.target.value })}
            className={roleInvalid ? 'border-destructive' : undefined}
          />
          {roleInvalid && (
            <p className="text-xs text-destructive">kebab-case identifier (a-z, 0-9, -)</p>
          )}
          {isDuplicate && <p className="text-xs text-destructive">duplicate role name</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`model-${draft.role}`}>Model</Label>
          <select
            id={`model-${draft.role}`}
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value as DraftAgent['model'] })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            data-testid={`model-${draft.role}`}
          >
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`tools-${index}`}>Allowed tools</Label>
          <Input
            id={`tools-${index}`}
            placeholder="Read, Edit, Write, Bash(npm:*, git:*)"
            value={draft.allowedToolsText}
            onChange={(e) => onChange({ ...draft, allowedToolsText: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated. e.g. Read, Edit, Write, Bash(npm:*, git:*)
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`prompt-${index}`}>System prompt</Label>
          <Textarea
            id={`prompt-${index}`}
            rows={10}
            value={draft.systemPrompt}
            onChange={(e) => onChange({ ...draft, systemPrompt: e.target.value })}
          />
          <p
            className={promptShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            data-testid={`prompt-count-${draft.role}`}
          >
            {promptLen} characters {promptShort ? `(min ${SYSTEM_PROMPT_MIN})` : ''}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

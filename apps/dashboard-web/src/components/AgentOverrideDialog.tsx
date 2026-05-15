/**
 * AgentOverrideDialog (v1.14 Phase 6) — per-role override editor.
 *
 * Opens from the OrgChartView when the user clicks a node. The user can:
 *   - swap the model (or leave at "Default" to inherit the role's base model)
 *   - append a project-specific snippet to the system prompt
 *   - add extra allowed tools (one per line, comma-or-newline tolerant)
 *   - assign a memory namespace so the role's memory is shared across
 *     projects when the namespace matches
 *
 * Persists via PUT /api/projects/:projectId/agent-overrides/:role. Reset
 * deletes the override row.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/use-toast';
import {
  useAgentOverrides,
  useDeleteAgentOverride,
  usePutAgentOverride,
  type AgentOverridePatch,
  type OrgChartRole,
} from '@/api/queries';

interface AgentOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  role: OrgChartRole | null;
}

type ModelOverride = 'opus' | 'sonnet' | 'haiku' | '';

const MODEL_VALUES: Array<{ value: ModelOverride; labelKey: string }> = [
  { value: '', labelKey: 'agentOverride.fields.modelDefault' },
  { value: 'opus', labelKey: 'opus' },
  { value: 'sonnet', labelKey: 'sonnet' },
  { value: 'haiku', labelKey: 'haiku' },
];

/** Parse a comma-or-newline-separated tool list, trimming and dropping empties. */
export function parseToolsList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function AgentOverrideDialog({
  open,
  onOpenChange,
  projectId,
  role,
}: AgentOverrideDialogProps) {
  const { t } = useTranslation();
  const { data: overrides } = useAgentOverrides(projectId);
  const put = usePutAgentOverride(projectId);
  const del = useDeleteAgentOverride(projectId);

  const existing = useMemo(() => {
    if (!role) return null;
    return overrides?.find((o) => o.role === role.role) ?? null;
  }, [overrides, role]);

  const [modelOverride, setModelOverride] = useState<ModelOverride>('');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [extraTools, setExtraTools] = useState('');
  const [memoryNamespace, setMemoryNamespace] = useState('');

  // Reset local state when the dialog opens against a new role / new override.
  useEffect(() => {
    if (!open) return;
    setModelOverride((existing?.model ?? '') as ModelOverride);
    setExtraPrompt(existing?.extraSystemPrompt ?? '');
    setExtraTools((existing?.extraAllowedTools ?? []).join('\n'));
    setMemoryNamespace(existing?.memoryNamespace ?? '');
  }, [open, existing]);

  if (!role) return null;

  const onSave = async () => {
    const tools = parseToolsList(extraTools);
    const patch: AgentOverridePatch = {
      model: modelOverride === '' ? null : modelOverride,
      extraSystemPrompt: extraPrompt.trim() === '' ? null : extraPrompt.trim(),
      extraAllowedTools: tools.length === 0 ? null : tools,
      memoryNamespace: memoryNamespace.trim() === '' ? null : memoryNamespace.trim(),
    };
    try {
      await put.mutateAsync({ role: role.role, patch });
      toast({ title: t('agentOverride.toasts.saved') });
      onOpenChange(false);
    } catch {
      toast({ title: t('agentOverride.toasts.saveFailed'), variant: 'destructive' });
    }
  };

  const onReset = async () => {
    if (!existing) {
      onOpenChange(false);
      return;
    }
    try {
      await del.mutateAsync(role.role);
      toast({ title: t('agentOverride.toasts.reset') });
      onOpenChange(false);
    } catch {
      toast({ title: t('agentOverride.toasts.resetFailed'), variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="agent-override-dialog" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('agentOverride.title', { role: role.displayName })}</DialogTitle>
          <DialogDescription>{t('agentOverride.description')}</DialogDescription>
        </DialogHeader>

        {/* Base role read-only summary */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-2xs">
          <Badge variant="outline">{role.role}</Badge>
          <Badge variant="outline">{role.model}</Badge>
          <span className="text-muted-foreground">{role.allowedToolsCount} tools</span>
          {role.description ? (
            <span className="text-muted-foreground">— {role.description}</span>
          ) : null}
        </div>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="aov-model">{t('agentOverride.fields.model')}</Label>
            <select
              id="aov-model"
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value as ModelOverride)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {MODEL_VALUES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.value === '' ? t('agentOverride.fields.modelDefault') : m.value}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="aov-extra-prompt">{t('agentOverride.fields.extraPrompt')}</Label>
            <Textarea
              id="aov-extra-prompt"
              data-testid="agent-override-extra-prompt"
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              rows={4}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="aov-extra-tools">{t('agentOverride.fields.extraTools')}</Label>
            <Textarea
              id="aov-extra-tools"
              value={extraTools}
              onChange={(e) => setExtraTools(e.target.value)}
              rows={3}
              placeholder={'Read\nWrite\nBash'}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="aov-namespace">{t('agentOverride.fields.memoryNamespace')}</Label>
            <Input
              id="aov-namespace"
              value={memoryNamespace}
              onChange={(e) => setMemoryNamespace(e.target.value)}
              placeholder="shared-architecture"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="agent-override-reset"
            onClick={onReset}
            disabled={del.isPending}
          >
            {t('agentOverride.actions.reset')}
          </Button>
          <Button
            type="button"
            data-testid="agent-override-save"
            onClick={onSave}
            disabled={put.isPending}
          >
            {t('agentOverride.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

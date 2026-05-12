/**
 * Agents tab — agent registry management.
 *
 * Two sections:
 *   1. Built-in team   — seed agents (Marcus + 9 specialists). Read-mostly:
 *      you can view/tweak the system prompt and avatar but not delete (the
 *      seeder would just re-install on next boot).
 *   2. Your agents     — user-created. Full CRUD with avatar picker.
 *
 * Each agent card shows: avatar, name, model, allowed-tools count, where it
 * is currently used (team count). Cards are arranged in a responsive grid.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Edit2, Plus, Trash2, ImageIcon, Users, ShieldCheck, Sparkles } from 'lucide-react';
import {
  useAgents,
  useAgentUsage,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from '@/api/queries';
import type { Agent, CreateAgentInput, UpdateAgentInput } from '@agent-harness/schemas';
import { Avatar } from '@/components/Avatar';
import { AvatarPicker } from '@/components/AvatarPicker';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/ui/error-banner';

const MODELS = ['opus', 'sonnet', 'haiku'] as const;
const DEFAULT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

function fmtRel(d: Date | string | number): string {
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export function AgentsRoute() {
  const { t } = useTranslation();
  const agents = useAgents();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const seedAgents = (agents.data ?? []).filter((a) => a.kind === 'seed');
  const userAgents = (agents.data ?? []).filter((a) => a.kind !== 'seed');

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('agents.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('agents.subtitleLead')}</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('agents.actions.new')}
        </button>
      </header>

      {agents.isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      )}

      {agents.error && (
        <ErrorBanner
          title={t('agents.loadFailed')}
          message={t('errors.retryHint')}
          onRetry={() => agents.refetch()}
        />
      )}

      {/* Section: Built-in team */}
      {seedAgents.length > 0 && (
        <section>
          <SectionHeading
            icon={<ShieldCheck className="h-4 w-4 text-info" />}
            title={t('agents.sections.builtin')}
            sub={t('agents.sections.builtinSub', { count: seedAgents.length })}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {seedAgents.map((a) => (
              <AgentCard key={a.id} agent={a} onEdit={() => setEditingId(a.id)} isSeed />
            ))}
          </div>
        </section>
      )}

      {/* Section: Your agents */}
      <section>
        <SectionHeading
          icon={<Sparkles className="h-4 w-4 text-foreground" />}
          title={t('agents.sections.your')}
          sub={
            userAgents.length > 0
              ? t('agents.sections.yourSub', { count: userAgents.length })
              : t('agents.sections.yourSubEmpty')
          }
        />
        {userAgents.length === 0 && !agents.isLoading ? (
          <div className="mt-3 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 py-10 text-center text-sm text-muted-foreground">
            <Bot className="h-6 w-6 opacity-60" />
            <span>{t('agents.emptyTitle')}</span>
            <button
              onClick={() => setCreating(true)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('agents.actions.createFirst')}
            </button>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {userAgents.map((a) => (
              <AgentCard key={a.id} agent={a} onEdit={() => setEditingId(a.id)} />
            ))}
          </div>
        )}
      </section>

      {creating && <AgentDialog mode="create" onClose={() => setCreating(false)} />}
      {editingId && (
        <AgentDialog mode="edit" agentId={editingId} onClose={() => setEditingId(null)} />
      )}
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b pb-2">
      {icon}
      <h2 className="text-base font-semibold">{title}</h2>
      <span className="text-xs text-muted-foreground">— {sub}</span>
    </div>
  );
}

function AgentCard({
  agent,
  onEdit,
  isSeed = false,
}: {
  agent: Agent;
  onEdit: () => void;
  isSeed?: boolean;
}) {
  const { t } = useTranslation();
  const usage = useAgentUsage(agent.id);
  const refCount = usage.data?.usage.length ?? 0;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteAgent();

  return (
    <div className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-info/30">
      <div className="flex items-start gap-3">
        <Avatar
          name={agent.name}
          avatarUrl={agent.avatarUrl ?? null}
          color={agent.color ?? null}
          size={48}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-sm font-semibold">{agent.name}</h3>
            <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
              {agent.model}
            </span>
            {isSeed && (
              <span className="rounded-full bg-info/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wider text-info">
                seed
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {agent.description ?? '—'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          {refCount > 0 ? t('agents.card.onTeams', { count: refCount }) : t('agents.card.unused')}
        </span>
        <span className="font-mono">
          {t('agents.card.tools', { count: agent.allowedTools.length })}
        </span>
        <span className="ml-auto font-mono">
          {fmtRel(agent.updatedAt as Date | string | number)}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-1 border-t border-border pt-3 opacity-60 transition-opacity group-hover:opacity-100">
        <button
          onClick={onEdit}
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
          title={isSeed ? t('agents.actions.view') : t('agents.actions.edit')}
        >
          <Edit2 className="h-3 w-3" />
          {isSeed ? t('agents.actions.view') : t('agents.actions.edit')}
        </button>
        {!isSeed && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
            title={t('agents.actions.delete')}
            aria-label={t('agents.actions.delete')}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={() => setConfirmDelete(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              {t('agents.deleteConfirm.title', { name: agent.name })}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {refCount > 0
                ? t('agents.deleteConfirm.usedOn', { count: refCount })
                : t('agents.deleteConfirm.unused')}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                {t('agents.actions.cancel')}
              </button>
              <button
                onClick={async () => {
                  try {
                    await del.mutateAsync({ id: agent.id, force: refCount > 0 });
                    setConfirmDelete(false);
                  } catch (err) {
                    console.error(err);
                  }
                }}
                disabled={del.isPending}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {del.isPending ? t('agents.actions.deleting') : t('agents.actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AgentDialogProps {
  mode: 'create' | 'edit';
  agentId?: string;
  onClose: () => void;
}

function AgentDialog({ mode, agentId, onClose }: AgentDialogProps) {
  const { t } = useTranslation();
  const agents = useAgents();
  const existing = mode === 'edit' && agentId ? agents.data?.find((a) => a.id === agentId) : null;
  const [name, setName] = useState(existing?.name ?? '');
  const [model, setModel] = useState<'opus' | 'sonnet' | 'haiku'>(existing?.model ?? 'sonnet');
  const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? '');
  const [tools, setTools] = useState<string[]>(
    existing?.allowedTools ?? ['Read', 'Edit', 'Bash', 'Grep'],
  );
  const [description, setDescription] = useState(existing?.description ?? '');
  const [color, setColor] = useState(existing?.color ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(existing?.avatarUrl ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateAgent();
  const update = useUpdateAgent();
  const submitting = create.isPending || update.isPending;

  useEffect(() => {
    if (mode === 'edit' && existing) {
      setName(existing.name);
      setModel(existing.model);
      setSystemPrompt(existing.systemPrompt);
      setTools(existing.allowedTools);
      setDescription(existing.description ?? '');
      setColor(existing.color ?? '');
      setAvatarUrl(existing.avatarUrl ?? null);
    }
  }, [mode, existing]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Name required.');
      return;
    }
    const promptLen = systemPrompt.trim().length;
    if (promptLen < 1) {
      setError('System prompt required.');
      return;
    }
    if (promptLen > 8000) {
      setError(`System prompt is too long (${promptLen}/8000 chars).`);
      return;
    }
    try {
      if (mode === 'create') {
        const input: CreateAgentInput = {
          name: name.trim(),
          model,
          systemPrompt: systemPrompt.trim(),
          allowedTools: tools,
          description: description.trim() || undefined,
          color: color.trim() || undefined,
          avatarUrl: avatarUrl ?? undefined,
        };
        await create.mutateAsync(input);
      } else if (mode === 'edit' && agentId) {
        const patch: UpdateAgentInput = {
          name: name.trim(),
          model,
          systemPrompt: systemPrompt.trim(),
          allowedTools: tools,
          description: description.trim() || undefined,
          color: color.trim() || undefined,
          avatarUrl: avatarUrl ?? undefined,
        };
        await update.mutateAsync({ id: agentId, patch });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  function toggleTool(tool: string) {
    setTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b px-5 py-3">
          <h3 className="text-base font-semibold">
            {mode === 'create' ? 'New agent' : `Edit ${existing?.name ?? ''}`}
          </h3>
          <p className="text-xs text-muted-foreground">
            {mode === 'create'
              ? 'Define a reusable agent. Chat history attaches to it across projects.'
              : 'Changes take effect immediately. Existing threads keep history.'}
          </p>
        </header>
        <div className="flex flex-col gap-4 overflow-auto px-5 py-4">
          {/* Avatar + Name + Model row */}
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="group relative shrink-0"
              title="Choose profile picture"
            >
              <Avatar
                name={name || 'New agent'}
                avatarUrl={avatarUrl}
                color={color || null}
                size={64}
              />
              <div className="absolute inset-0 grid place-items-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <ImageIcon className="h-5 w-5 text-white" />
              </div>
            </button>
            <div className="grid flex-1 grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="agent-name"
                  className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Name
                </label>
                <input
                  id="agent-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. architect-sam"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-info"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Model
                </label>
                <div className="mt-1 flex gap-1">
                  {MODELS.map((m) => (
                    <button
                      key={m}
                      onClick={() => setModel(m)}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-sm font-medium ${model === m ? 'border-info bg-info/10 text-info-foreground' : 'hover:bg-muted'}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div>
            <label
              htmlFor="agent-prompt"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              System prompt
            </label>
            <textarea
              id="agent-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
              placeholder="You are an opinionated TypeScript architect. You evaluate trade-offs honestly and prefer minimal abstractions…"
              className="mt-1 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-info"
            />
            <div
              className={`mt-1 text-2xs ${systemPrompt.length > 8000 ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {systemPrompt.length} / 8000 chars
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Allowed tools
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {DEFAULT_TOOLS.map((t) => {
                const on = tools.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleTool(t)}
                    className={`rounded-full border px-2.5 py-0.5 font-mono text-2xs tracking-tight ${on ? 'border-info bg-info/15 text-info-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="agent-desc"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Description (optional)
              </label>
              <input
                id="agent-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Specialty, when to use…"
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-info"
              />
            </div>
            <div>
              <label
                htmlFor="agent-color"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Accent color (optional)
              </label>
              <input
                id="agent-color"
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder={t('agents.dialog.colorPlaceholder')}
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:border-info"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {submitting ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save'}
          </button>
        </footer>
      </div>

      <AvatarPicker
        open={pickerOpen}
        selected={avatarUrl}
        name={name || 'New agent'}
        onSelect={setAvatarUrl}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

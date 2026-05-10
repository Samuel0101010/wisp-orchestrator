/**
 * Full-page chat — Microsoft-Teams-style 3-pane layout.
 *
 *   ┌────────┬───────────────────────────────────┬────────┐
 *   │        │              messages              │        │
 *   │ thread │  ──────────────────────────────── │ people │
 *   │  list  │              composer              │  list  │
 *   └────────┴───────────────────────────────────┴────────┘
 *
 * The center transcript shows multi-author chat: each assistant message has
 * an avatar + author name; user messages are right-aligned. Inline cards
 * surface manager directive results (e.g. "Created project X — open").
 *
 * Threads are scoped to whichever agent the user picked from the manager-led
 * "New chat with team" entry point. By default the manager (seedKey='manager')
 * is the thread agent, which auto-promotes them as participant.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2,
  MessageSquarePlus,
  Plus,
  Send,
  Trash2,
  Sparkles,
  Users,
  ArrowRight,
  ChevronRight,
  X,
} from 'lucide-react';
import {
  type ChatActionRow,
  type ThreadParticipantSummary,
  useAddParticipant,
  useAgents,
  useAgentThreads,
  useCompressThread,
  useCreateThread,
  useDeleteThread,
  useRemoveParticipant,
  useSendMessage,
  useThreadDetail,
  useThreadMessages,
} from '@/api/queries';
import type { Agent, AgentMessage, AgentThread } from '@agent-harness/schemas';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';

function fmtRel(d: Date | string | number): string {
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

function fmtTime(d: Date | string | number): string {
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function ChatRoute() {
  const agents = useAgents();
  const manager = useMemo<Agent | null>(
    () => agents.data?.find((a) => a.seedKey === 'manager') ?? null,
    [agents.data],
  );
  const seedTeam = useMemo<Agent[]>(
    () => agents.data?.filter((a) => a.seedKey && a.seedKey !== 'manager') ?? [],
    [agents.data],
  );

  // The user always chats *with the manager* on this page. Threads are scoped
  // to the manager agent so all multi-agent conversations live on one page.
  const managerId = manager?.id;
  const threads = useAgentThreads(managerId);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const messages = useThreadMessages(selectedThreadId ?? undefined);
  const detail = useThreadDetail(selectedThreadId ?? undefined);
  const createThread = useCreateThread();
  const deleteThread = useDeleteThread();
  const compress = useCompressThread();
  const sendMessage = useSendMessage();
  const addParticipant = useAddParticipant();
  const removeParticipant = useRemoveParticipant();

  // Auto-pick first thread.
  useEffect(() => {
    if (!selectedThreadId && threads.data && threads.data.length > 0) {
      setSelectedThreadId(threads.data[0]?.id ?? null);
    }
  }, [selectedThreadId, threads.data]);

  // Auto-scroll to bottom on new messages.
  const scrollEnd = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.data?.length, sendMessage.isPending]);

  const [composer, setComposer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);

  async function startNewThread() {
    if (!managerId) return;
    setError(null);
    try {
      const t = await createThread.mutateAsync({
        agentId: managerId,
        input: { projectId: null },
      });
      setSelectedThreadId(t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function send() {
    if (!composer.trim() || !selectedThreadId || !managerId) return;
    if (sendMessage.isPending) return;
    setError(null);
    let threadId = selectedThreadId;
    if (!threadId) {
      try {
        const t = await createThread.mutateAsync({
          agentId: managerId,
          input: { projectId: null },
        });
        threadId = t.id;
        setSelectedThreadId(t.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const content = composer;
    setComposer('');
    try {
      await sendMessage.mutateAsync({ threadId, agentId: managerId, content });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Restore the composer text so the user doesn't lose their message.
      setComposer(content);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  // ---- Loading + empty states ----
  if (agents.isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading team…
      </div>
    );
  }
  if (!manager) {
    return (
      <div className="flex h-[80vh] flex-col items-center justify-center gap-3 text-center">
        <Sparkles className="h-7 w-7 text-info" />
        <div className="text-base font-semibold">Team chat is not seeded yet.</div>
        <p className="max-w-md text-sm text-muted-foreground">
          The built-in dev team (Marcus + 9 specialists) is installed automatically
          on first server boot. Restart the dashboard server, then return here.
        </p>
        <Link to="/agents" className="text-sm underline">
          Open Agents settings
        </Link>
      </div>
    );
  }

  const threadList = threads.data ?? [];
  const messageList = messages.data ?? [];
  const participants = detail.data?.participants ?? [];
  const actions = detail.data?.actions ?? [];

  return (
    <div className="-m-6 grid h-[calc(100vh-3.5rem)] grid-cols-[260px_1fr_280px] overflow-hidden">
      {/* ──────────── LEFT: Thread list ──────────── */}
      <aside className="flex h-full flex-col border-r bg-card/40">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Conversations</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={startNewThread}
            disabled={createThread.isPending}
            title="New conversation"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {threadList.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No conversations yet.
              <button
                onClick={startNewThread}
                className="mt-2 block w-full rounded-md border bg-info/10 py-1.5 text-info"
              >
                Start with the team
              </button>
            </div>
          )}
          {threadList.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={selectedThreadId === t.id}
              onClick={() => setSelectedThreadId(t.id)}
              onDelete={async () => {
                if (selectedThreadId === t.id) setSelectedThreadId(null);
                try {
                  await deleteThread.mutateAsync({ threadId: t.id, agentId: manager.id });
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          ))}
        </div>
      </aside>

      {/* ──────────── CENTER: Transcript ──────────── */}
      <section className="flex h-full min-w-0 flex-col">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={manager.name} avatarUrl={manager.avatarUrl ?? null} size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {detail.data?.thread.title ?? 'Team chat with Marcus'}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
                {detail.data?.actions && detail.data.actions.length > 0 && (
                  <> · {detail.data.actions.length} actions</>
                )}
              </div>
            </div>
          </div>
          {selectedThreadId && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedThreadId || compress.isPending || messageList.length < 4}
                onClick={async () => {
                  if (!selectedThreadId) return;
                  try {
                    await compress.mutateAsync({ threadId: selectedThreadId });
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
                title={
                  messageList.length < 4
                    ? 'Need at least 4 messages to compress'
                    : 'Summarise this conversation into one message'
                }
              >
                {compress.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : null}
                Compress
              </Button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!selectedThreadId && (
            <EmptyTranscript onStart={startNewThread} />
          )}
          {selectedThreadId && messageList.length === 0 && !sendMessage.isPending && (
            <ConversationStarter manager={manager} />
          )}
          {selectedThreadId && (
            <Transcript
              messages={messageList}
              actions={actions}
              participants={participants}
              manager={manager}
              isPending={sendMessage.isPending}
            />
          )}
          <div ref={scrollEnd} />
        </div>

        {/* Composer */}
        {selectedThreadId && (
          <div className="border-t px-5 py-3">
            {error && (
              <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                {error}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm">
              <textarea
                aria-label="Message composer"
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={handleKey}
                placeholder={`Message Marcus + team — ⌘⏎ to send. Type @ to mention a teammate.`}
                rows={1}
                className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none"
              />
              <Button
                size="icon"
                onClick={send}
                disabled={!composer.trim() || sendMessage.isPending}
                title="Send (⌘⏎)"
              >
                {sendMessage.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ──────────── RIGHT: Participants ──────────── */}
      <aside className="flex h-full flex-col border-l bg-card/40">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4" /> People
          </div>
          {selectedThreadId && (
            <Button
              variant="ghost"
              size="icon"
              title="Add member"
              onClick={() => setShowAddMember(true)}
              disabled={!selectedThreadId}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {participants.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No conversation selected.
            </div>
          )}
          {participants.map((p) => {
            const a = agents.data?.find((x) => x.id === p.agentId) ?? null;
            return (
              <ParticipantRow
                key={p.agentId}
                participant={p}
                agent={a}
                onRemove={
                  p.role === 'member' && selectedThreadId
                    ? async () => {
                        try {
                          await removeParticipant.mutateAsync({
                            threadId: selectedThreadId,
                            agentId: p.agentId,
                          });
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }
                    : null
                }
              />
            );
          })}
        </div>
        <div className="border-t p-3 text-[11px] text-muted-foreground">
          Marcus stays in every conversation. Add specialists to bring them into
          the chat — or @mention them inline.
        </div>
      </aside>

      {showAddMember && selectedThreadId && (
        <AddMemberDialog
          team={seedTeam}
          existing={participants.map((p) => p.agentId)}
          customAgents={
            agents.data?.filter((a) => a.kind !== 'seed') ?? []
          }
          onPick={async (agentId) => {
            try {
              await addParticipant.mutateAsync({
                threadId: selectedThreadId,
                agentId,
              });
              setShowAddMember(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          onClose={() => setShowAddMember(false)}
        />
      )}
    </div>
  );
}

// ---- ThreadRow ----

function ThreadRow({
  thread,
  active,
  onClick,
  onDelete,
}: {
  thread: AgentThread;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`group flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-accent ${
        active ? 'bg-accent' : ''
      }`}
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {thread.title ?? 'Untitled chat'}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {fmtRel(thread.updatedAt)} ago
        </div>
      </div>
      {hover && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm('Delete this conversation? This cannot be undone.')) {
              onDelete();
            }
          }}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ---- ParticipantRow ----

function ParticipantRow({
  participant,
  agent,
  onRemove,
}: {
  participant: ThreadParticipantSummary;
  agent: Agent | null;
  onRemove: (() => Promise<void>) | null;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
      <Avatar
        name={participant.name}
        avatarUrl={agent?.avatarUrl ?? null}
        color={agent?.color ?? null}
        size={36}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{participant.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {agent?.description ?? ''}
        </div>
      </div>
      {participant.role === 'manager' && (
        <span className="rounded-full bg-info/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-info">
          Lead
        </span>
      )}
      {onRemove && (
        <button
          onClick={() => {
            if (confirm(`Remove ${participant.name} from this conversation?`)) {
              void onRemove();
            }
          }}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Remove from chat"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  );
}

// ---- Empty state ----

function EmptyTranscript({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-12 text-center">
      <Sparkles className="h-10 w-10 text-info" />
      <div className="text-lg font-semibold">Brainstorm with the team</div>
      <p className="max-w-md text-sm text-muted-foreground">
        Marcus (Project Manager) chairs every conversation. He can pull
        specialists in, then create + start a project once you've agreed on
        direction.
      </p>
      <Button onClick={onStart}>
        <MessageSquarePlus className="mr-2 h-4 w-4" /> Start conversation
      </Button>
    </div>
  );
}

function ConversationStarter({ manager }: { manager: Agent }) {
  return (
    <div className="rounded-xl border-2 border-dashed bg-muted/30 p-6">
      <div className="flex items-start gap-4">
        <Avatar name={manager.name} avatarUrl={manager.avatarUrl ?? null} size={48} />
        <div className="space-y-2 text-sm">
          <div className="font-semibold">Marcus</div>
          <p className="text-muted-foreground">
            Hi! Tell me what you're thinking about — a feature idea, a bug to
            chase, or a fresh project. I'll loop in the specialists you need.
          </p>
          <p className="text-xs text-muted-foreground">
            Tip: type <code className="rounded bg-muted px-1">@Lena</code> to
            address the frontend lead directly.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---- Transcript (multi-author bubbles + action cards) ----

function Transcript({
  messages,
  actions,
  participants,
  manager,
  isPending,
}: {
  messages: AgentMessage[];
  actions: ChatActionRow[];
  participants: ThreadParticipantSummary[];
  manager: Agent;
  isPending: boolean;
}) {
  // Build a map: messageId → actions[] so we can render action cards below
  // their parent manager message.
  const actionsByMessage = useMemo(() => {
    const map = new Map<string, ChatActionRow[]>();
    for (const a of actions) {
      if (!a.messageId) continue;
      const arr = map.get(a.messageId) ?? [];
      arr.push(a);
      map.set(a.messageId, arr);
    }
    return map;
  }, [actions]);

  return (
    <div className="space-y-4">
      {messages.map((m) => (
        <MessageBlock
          key={m.id}
          message={m}
          participants={participants}
          manager={manager}
          actions={actionsByMessage.get(m.id) ?? []}
        />
      ))}
      {isPending && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Manager is typing…
        </div>
      )}
    </div>
  );
}

function MessageBlock({
  message,
  participants,
  manager,
  actions,
}: {
  message: AgentMessage;
  participants: ThreadParticipantSummary[];
  manager: Agent;
  actions: ChatActionRow[];
}) {
  const isUser = message.role === 'user';
  const author = !isUser
    ? participants.find((p) => p.agentId === message.authorAgentId) ?? {
        agentId: manager.id,
        name: manager.name,
        seedKey: manager.seedKey ?? null,
        role: 'manager' as const,
      }
    : null;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%] rounded-2xl rounded-br-sm bg-info/10 px-4 py-2 text-sm">
          <div className="whitespace-pre-wrap">{message.content}</div>
          <div className="mt-1 text-right text-[10px] text-muted-foreground">
            {fmtTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  // Look up the agent record for the author so we can fetch avatarUrl.
  const authorName = author?.name ?? 'Agent';
  // Bubble has the avatar to the left.
  return (
    <div className="flex items-start gap-3">
      <AuthorAvatar authorAgentId={message.authorAgentId} name={authorName} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className="text-sm font-semibold">{authorName}</span>
          <span className="text-[10px] text-muted-foreground">
            {fmtTime(message.createdAt)}
          </span>
          {message.errorReason === 'pending' && (
            <span className="rounded bg-warning/20 px-1 text-[9px] uppercase text-warning">
              interrupted
            </span>
          )}
          {message.errorReason === 'timeout' && (
            <span className="rounded bg-destructive/20 px-1 text-[9px] font-semibold text-destructive">
              Timeout (180s)
            </span>
          )}
          {message.errorReason && message.errorReason !== 'pending' && message.errorReason !== 'timeout' && (
            <span className="rounded bg-destructive/20 px-1 text-[9px] uppercase text-destructive">
              {message.errorReason}
            </span>
          )}
        </div>
        <div className="rounded-2xl rounded-tl-sm bg-card px-4 py-2 text-sm shadow-sm ring-1 ring-border">
          <div className="whitespace-pre-wrap">{message.content || '(no response)'}</div>
        </div>
        {actions.length > 0 && (
          <div className="mt-2 space-y-1">
            {actions.map((a) => (
              <ActionCard key={a.id} action={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AuthorAvatar({
  authorAgentId,
  name,
}: {
  authorAgentId: string | null | undefined;
  name: string;
}) {
  const agents = useAgents();
  const agent = authorAgentId ? agents.data?.find((a) => a.id === authorAgentId) : null;
  return <Avatar name={name} avatarUrl={agent?.avatarUrl ?? null} color={agent?.color ?? null} size={32} />;
}

// ---- Action card ----

function ActionCard({ action }: { action: ChatActionRow }) {
  const status = action.status;
  const palette =
    status === 'ok'
      ? 'border-success/40 bg-success/5'
      : status === 'failed'
      ? 'border-destructive/40 bg-destructive/5'
      : 'border-info/40 bg-info/5';

  if (action.kind === 'create_project' && status === 'ok') {
    const r = action.resultJson as { projectId: string; name: string; teamSize: number } | null;
    return (
      <div className={`rounded-lg border ${palette} p-3 text-xs`}>
        <div className="font-semibold">Project created · {r?.name}</div>
        <div className="text-muted-foreground">
          Team of {r?.teamSize}. Ready to plan & run.
        </div>
        {r?.projectId && (
          <Link
            to={`/projects/${r.projectId}`}
            className="mt-1 inline-flex items-center gap-1 text-info hover:underline"
          >
            Open project <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    );
  }
  if (action.kind === 'add_member' && status === 'ok') {
    const r = action.resultJson as { name?: string } | null;
    return (
      <div className={`rounded-lg border ${palette} p-3 text-xs`}>
        Added <strong>{r?.name ?? 'member'}</strong> to the conversation.
      </div>
    );
  }
  if (action.kind === 'consult' && status === 'ok') {
    const r = action.resultJson as { consultedName?: string } | null;
    return (
      <div className={`rounded-lg border ${palette} p-3 text-xs`}>
        Consulted <strong>{r?.consultedName ?? 'specialist'}</strong>. Reply
        posted below ↓
      </div>
    );
  }
  if (action.kind === 'start_run') {
    const r = action.resultJson as { runId?: string; reason?: string } | null;
    if (status === 'ok' && r?.runId) {
      return (
        <div className={`rounded-lg border ${palette} p-3 text-xs`}>
          Started run <code className="font-mono">{r.runId.slice(0, 8)}</code>.
        </div>
      );
    }
    if (r?.reason === 'no_plan_yet') {
      return (
        <div className={`rounded-lg border ${palette} p-3 text-xs`}>
          Cannot start run yet — no plan. Open the project to generate one.
        </div>
      );
    }
  }
  if (action.kind === 'invoke_skill' && status === 'ok') {
    const r = action.resultJson as {
      skillName?: string;
      tokensIn?: number;
      tokensOut?: number;
      durationMs?: number;
    } | null;
    const payload = action.payloadJson as { name?: string } | null;
    const tokens = (r?.tokensIn ?? 0) + (r?.tokensOut ?? 0);
    return (
      <div className={`rounded-lg border ${palette} p-3 text-xs`}>
        <span className="mr-2 inline-flex items-center gap-1 text-muted-foreground">
          🔧 invoked skill
        </span>
        <span className="font-mono font-semibold">{r?.skillName ?? payload?.name ?? 'unknown'}</span>
        <span className="ml-2 text-muted-foreground">
          ({tokens} tokens, {r?.durationMs ?? 0}ms)
        </span>
      </div>
    );
  }
  if (status === 'failed') {
    const r = action.resultJson as { error?: string } | null;
    return (
      <div className={`rounded-lg border ${palette} p-3 text-xs`}>
        <div className="font-semibold">Action failed: {action.kind}</div>
        <div className="text-muted-foreground">{r?.error ?? 'unknown error'}</div>
      </div>
    );
  }
  return (
    <div className={`rounded-lg border ${palette} p-3 text-xs`}>
      Action: {action.kind} · {status}
    </div>
  );
}

// ---- Add-member dialog ----

function AddMemberDialog({
  team,
  customAgents,
  existing,
  onPick,
  onClose,
}: {
  team: Agent[];
  customAgents: Agent[];
  existing: string[];
  onPick: (agentId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'team' | 'custom'>('team');
  const list = tab === 'team' ? team : customAgents;
  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between border-b px-5 py-3">
          <h3 className="text-base font-semibold">Add to conversation</h3>
          <button
            onClick={onClose}
            className="font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            close
          </button>
        </header>
        <div className="flex border-b text-xs">
          <button
            onClick={() => setTab('team')}
            className={`flex-1 px-4 py-2 ${tab === 'team' ? 'border-b-2 border-info font-medium' : 'text-muted-foreground'}`}
          >
            Built-in team
          </button>
          <button
            onClick={() => setTab('custom')}
            className={`flex-1 px-4 py-2 ${tab === 'custom' ? 'border-b-2 border-info font-medium' : 'text-muted-foreground'}`}
          >
            Your agents
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {tab === 'custom'
                ? 'No custom agents yet. Create one in Agents settings.'
                : 'No team members.'}
            </div>
          )}
          {list.map((a) => {
            const already = existing.includes(a.id);
            return (
              <button
                key={a.id}
                disabled={already}
                onClick={() => onPick(a.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Avatar name={a.name} avatarUrl={a.avatarUrl ?? null} color={a.color ?? null} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {a.description ?? ''}
                  </div>
                </div>
                {already ? (
                  <span className="text-[10px] text-muted-foreground">in chat</span>
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

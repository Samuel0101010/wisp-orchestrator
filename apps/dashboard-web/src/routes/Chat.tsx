/**
 * Full-page chat — Microsoft-Teams-style 3-pane layout.
 *
 *   Left pane: thread list (260px wide).
 *   Center pane: transcript above a composer.
 *   Right pane: participants (280px wide).
 *
 * The center transcript shows multi-author chat: each assistant message has
 * an avatar + author name; user messages are right-aligned. Inline cards
 * surface manager directive results (e.g. "Created project X — open").
 *
 * Threads are scoped to whichever agent the user picked from the manager-led
 * "New chat with team" entry point. By default the manager (seedKey='manager')
 * is the thread agent, which auto-promotes them as participant.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  CheckCircle2,
  Info,
  XCircle,
  Wrench,
} from 'lucide-react';
import { fmtRel } from '@/lib/fmt-rel';
import { cn } from '@/lib/utils';
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
import type { Agent, AgentMessage, AgentThread } from '@wisp/schemas';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function fmtTime(d: Date | string | number, lang: string): string {
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  return new Date(t).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

export function ChatRoute() {
  const { t, i18n } = useTranslation();
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
  // Mention picker state. null = closed; '' or 'Le' = open with that query.
  // mentionStart is the caret index of the `@` that opened the picker.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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

  // Compute participants list once per render for mention filtering.
  const mentionCandidates = useMemo(() => {
    const list = detail.data?.participants ?? [];
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const filtered = q === '' ? list : list.filter((p) => p.name.toLowerCase().includes(q));
    return filtered.slice(0, 8);
  }, [detail.data?.participants, mentionQuery]);

  // Update mention picker state from the latest composer text + caret.
  function syncMentionState(text: string, caret: number) {
    // Walk backwards from caret to find the start of the current word.
    let i = caret;
    while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
    const word = text.slice(i, caret);
    if (word.startsWith('@')) {
      setMentionStart(i);
      setMentionQuery(word.slice(1));
      setMentionIndex(0);
    } else if (mentionQuery !== null) {
      setMentionQuery(null);
      setMentionStart(null);
    }
  }

  function onComposerChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setComposer(text);
    syncMentionState(text, e.target.selectionStart ?? text.length);
  }

  function insertMention(name: string) {
    const ta = composerRef.current;
    if (mentionStart === null || !ta) return;
    const caret = ta.selectionStart ?? composer.length;
    const before = composer.slice(0, mentionStart);
    const after = composer.slice(caret);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setComposer(next);
    setMentionQuery(null);
    setMentionStart(null);
    // Restore caret right after the inserted mention.
    const newCaret = before.length + inserted.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const pick = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
        if (pick) insertMention(pick.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        setMentionStart(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  // ---- Loading + empty states ----
  if (agents.isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('chat.loading')}
      </div>
    );
  }
  if (!manager) {
    return (
      <div className="flex h-[80vh] flex-col items-center justify-center gap-3 text-center">
        <Sparkles className="h-7 w-7 text-info" />
        <div className="text-base font-semibold">{t('chat.notSeeded')}</div>
        <p className="max-w-md text-sm text-muted-foreground">{t('chat.notSeededBody')}</p>
        <Link to="/agents" className="text-sm underline">
          {t('chat.openAgentsSettings')}
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
      {/* LEFT: Thread list */}
      <aside className="flex h-full min-h-0 flex-col border-r bg-card/40">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">{t('chat.sidebar.title')}</span>
          <IconButton
            icon={<MessageSquarePlus className="h-4 w-4" />}
            label={t('tooltips.newThread')}
            onClick={startNewThread}
            disabled={createThread.isPending}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {threadList.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {t('chat.sidebar.empty')}
              <button
                onClick={startNewThread}
                className="mt-2 block w-full rounded-md border bg-info/10 py-1.5 text-info"
              >
                {t('chat.sidebar.startCta')}
              </button>
            </div>
          )}
          {threadList.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              active={selectedThreadId === thread.id}
              lang={i18n.language}
              onClick={() => setSelectedThreadId(thread.id)}
              onDelete={async () => {
                if (selectedThreadId === thread.id) setSelectedThreadId(null);
                try {
                  await deleteThread.mutateAsync({ threadId: thread.id, agentId: manager.id });
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          ))}
        </div>
      </aside>

      {/* CENTER: Transcript */}
      <section className="flex h-full min-h-0 min-w-0 flex-col">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={manager.name} avatarUrl={manager.avatarUrl ?? null} size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {detail.data?.thread.title ?? t('chat.header.defaultTitle')}
              </div>
              <div className="text-xs2 text-muted-foreground">
                {t('chat.header.participants', { count: participants.length })}
                {detail.data?.actions && detail.data.actions.length > 0 && (
                  <> · {t('chat.header.actions', { count: detail.data.actions.length })}</>
                )}
              </div>
            </div>
          </div>
          {selectedThreadId && (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
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
                  >
                    {compress.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {t('chat.header.compress')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('tooltips.compressThread')}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!selectedThreadId && <EmptyTranscript onStart={startNewThread} />}
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
            <div className="relative flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm">
              {mentionQuery !== null && mentionCandidates.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Mention picker"
                  className="absolute bottom-full left-2 z-10 mb-1 w-64 overflow-hidden rounded-lg border bg-popover shadow-lg"
                >
                  {mentionCandidates.map((p, idx) => (
                    <button
                      key={p.agentId}
                      type="button"
                      role="option"
                      aria-selected={idx === mentionIndex}
                      onMouseDown={(e) => {
                        // Prevent textarea blur before we insert.
                        e.preventDefault();
                        insertMention(p.name);
                      }}
                      onMouseEnter={() => setMentionIndex(idx)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                        idx === mentionIndex ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="truncate font-medium">{p.name}</span>
                      {p.role === 'manager' && (
                        <span className="ml-auto text-3xs uppercase text-muted-foreground">
                          {t('chat.participants.roleLead')}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                aria-label={t('chat.composer.ariaLabel')}
                value={composer}
                onChange={onComposerChange}
                onKeyUp={(e) => {
                  const ta = e.currentTarget;
                  syncMentionState(ta.value, ta.selectionStart ?? ta.value.length);
                }}
                onClick={(e) => {
                  const ta = e.currentTarget;
                  syncMentionState(ta.value, ta.selectionStart ?? ta.value.length);
                }}
                onBlur={() => {
                  // Close picker on blur (outside click). Slight delay so
                  // mousedown on the listbox can fire first.
                  setTimeout(() => setMentionQuery(null), 100);
                }}
                onKeyDown={handleKey}
                placeholder={t('chat.composer.placeholder')}
                rows={1}
                className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none"
              />
              <IconButton
                icon={
                  sendMessage.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )
                }
                label={t('tooltips.sendMessage')}
                variant="default"
                onClick={send}
                disabled={!composer.trim() || sendMessage.isPending}
              />
            </div>
          </div>
        )}
      </section>

      {/* RIGHT: Participants */}
      <aside className="flex h-full min-h-0 flex-col border-l bg-card/40">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4" /> {t('chat.participants.title')}
          </div>
          {selectedThreadId && (
            <IconButton
              icon={<Plus className="h-4 w-4" />}
              label={t('tooltips.addMember')}
              onClick={() => setShowAddMember(true)}
              disabled={!selectedThreadId}
            />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {participants.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {t('chat.participants.empty')}
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
        <div className="border-t p-3 text-xs2 text-muted-foreground">
          {t('chat.participants.permanent')}
        </div>
      </aside>

      {showAddMember && selectedThreadId && (
        <AddMemberDialog
          team={seedTeam}
          existing={participants.map((p) => p.agentId)}
          customAgents={agents.data?.filter((a) => a.kind !== 'seed') ?? []}
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
  lang,
  onClick,
  onDelete,
}: {
  thread: AgentThread;
  active: boolean;
  lang: string;
  onClick: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
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
          {thread.title ?? t('chat.thread.untitled')}
        </div>
        <div className="text-2xs text-muted-foreground">{fmtRel(thread.updatedAt, lang)}</div>
      </div>
      {hover && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(t('chat.thread.deleteConfirm'))) {
              onDelete();
            }
          }}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          title={t('chat.thread.deleteLabel')}
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
  const { t } = useTranslation();
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
        <div className="truncate text-xs2 text-muted-foreground">{agent?.description ?? ''}</div>
      </div>
      {participant.role === 'manager' && (
        <span className="rounded-full bg-info/15 px-2 py-0.5 text-3xs font-semibold uppercase tracking-wider text-info">
          {t('chat.participants.roleLead')}
        </span>
      )}
      {onRemove && (
        <IconButton
          icon={<X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />}
          label={t('tooltips.removeMember')}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => {
            if (confirm(t('chat.participants.removeConfirm', { name: participant.name }))) {
              void onRemove();
            }
          }}
        />
      )}
    </div>
  );
}

// ---- Empty state ----

function EmptyTranscript({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-12 text-center">
      <Sparkles className="h-10 w-10 text-info" />
      <div className="text-lg font-semibold">{t('chat.greeter.title')}</div>
      <p className="max-w-md text-sm text-muted-foreground">{t('chat.greeter.body')}</p>
      <Button onClick={onStart}>
        <MessageSquarePlus className="mr-2 h-4 w-4" /> {t('chat.greeter.startButton')}
      </Button>
    </div>
  );
}

function ConversationStarter({ manager }: { manager: Agent }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border-2 border-dashed bg-muted/30 p-6">
      <div className="flex items-start gap-4">
        <Avatar name={manager.name} avatarUrl={manager.avatarUrl ?? null} size={48} />
        <div className="space-y-2 text-sm">
          <div className="font-semibold">{t('chat.greeter.starterName')}</div>
          <p className="text-muted-foreground">{t('chat.greeter.starterGreeting')}</p>
          <p
            className="text-xs text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1"
            dangerouslySetInnerHTML={{ __html: t('chat.greeter.tip') }}
          />
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
  const { t, i18n } = useTranslation();
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
          lang={i18n.language}
        />
      ))}
      {isPending && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('chat.transcript.typing')}
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
  lang,
}: {
  message: AgentMessage;
  participants: ThreadParticipantSummary[];
  manager: Agent;
  actions: ChatActionRow[];
  lang: string;
}) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const author = !isUser
    ? (participants.find((p) => p.agentId === message.authorAgentId) ?? {
        agentId: manager.id,
        name: manager.name,
        seedKey: manager.seedKey ?? null,
        role: 'manager' as const,
      })
    : null;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%] rounded-2xl rounded-tr-md bg-info/10 px-4 py-2 text-sm">
          <div className="whitespace-pre-wrap">{message.content}</div>
          <div className="mt-1 text-right text-2xs text-muted-foreground">
            {fmtTime(message.createdAt, lang)}
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
          <span className="text-2xs text-muted-foreground">{fmtTime(message.createdAt, lang)}</span>
          {/* Error tags: tone-tinted bg carries the semantic signal; foreground
              text (not text-{tone}) is required for AA contrast on tinted
              surfaces in both themes. */}
          {message.errorReason === 'pending' && (
            <span className="rounded bg-warning/20 px-1 text-3xs uppercase text-foreground">
              {t('chat.transcript.interrupted')}
            </span>
          )}
          {message.errorReason === 'timeout' && (
            <span className="rounded bg-destructive/20 px-1 text-3xs font-semibold text-foreground">
              {t('chat.transcript.timeout')}
            </span>
          )}
          {message.errorReason &&
            message.errorReason !== 'pending' &&
            message.errorReason !== 'timeout' && (
              <span className="rounded bg-destructive/20 px-1 text-3xs uppercase text-foreground">
                {message.errorReason}
              </span>
            )}
        </div>
        <div className="px-0.5 py-1 text-sm text-foreground">
          <div className="whitespace-pre-wrap">
            {message.content || t('chat.transcript.noResponse')}
          </div>
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
  return (
    <Avatar
      name={name}
      avatarUrl={agent?.avatarUrl ?? null}
      color={agent?.color ?? null}
      size={32}
    />
  );
}

// ---- Action card ----

// Lucide icon prefix for receipts. Color-only signal fails the
// "color is not the only cue" a11y heuristic — every receipt also carries an icon.
function ReceiptIcon({ tone }: { tone: 'success' | 'info' | 'destructive' }) {
  if (tone === 'destructive') {
    return <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />;
  }
  if (tone === 'info') {
    return <Info className="size-3.5 shrink-0 text-info" aria-hidden />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />;
}

function ActionCard({ action }: { action: ChatActionRow }) {
  const { t } = useTranslation();
  const status = action.status;
  const tone: 'success' | 'info' | 'destructive' =
    status === 'ok' ? 'success' : status === 'failed' ? 'destructive' : 'info';
  const palette =
    tone === 'success'
      ? 'border-success/40 bg-success/5'
      : tone === 'destructive'
        ? 'border-destructive/40 bg-destructive/5'
        : 'border-info/40 bg-info/5';
  const cardClass = cn('rounded-lg border p-3 text-xs', palette);

  if (action.kind === 'create_project' && status === 'ok') {
    const r = action.resultJson as { projectId: string; name: string; teamSize: number } | null;
    return (
      <div className={cardClass}>
        <div className="flex items-center gap-1.5 font-semibold">
          <ReceiptIcon tone="success" />
          {t('chat.action.projectCreated', { name: r?.name })}
        </div>
        <div className="mt-0.5 pl-5 text-muted-foreground">
          {t('chat.action.projectTeam', { count: r?.teamSize ?? 0 })}
        </div>
        {r?.projectId && (
          <Link
            to={`/projects/${r.projectId}`}
            className="mt-1 ml-5 inline-flex items-center gap-1 text-info hover:underline"
          >
            {t('chat.action.openProject')} <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    );
  }
  if (action.kind === 'add_member' && status === 'ok') {
    const r = action.resultJson as { name?: string } | null;
    return (
      <div className={cardClass}>
        <div className="flex items-center gap-1.5">
          <ReceiptIcon tone="success" />
          <span
            dangerouslySetInnerHTML={{
              __html: t('chat.action.memberAdded', { name: r?.name ?? 'member' }),
            }}
          />
        </div>
      </div>
    );
  }
  if (action.kind === 'consult' && status === 'ok') {
    const r = action.resultJson as { consultedName?: string } | null;
    return (
      <div className={cardClass}>
        <div className="flex items-center gap-1.5">
          <ReceiptIcon tone="success" />
          <span
            dangerouslySetInnerHTML={{
              __html: t('chat.action.consulted', { name: r?.consultedName ?? 'specialist' }),
            }}
          />
        </div>
      </div>
    );
  }
  if (action.kind === 'start_run') {
    const r = action.resultJson as { runId?: string; reason?: string } | null;
    if (status === 'ok' && r?.runId) {
      return (
        <div className={cardClass}>
          <div className="flex items-center gap-1.5 font-mono">
            <ReceiptIcon tone="success" />
            <span
              dangerouslySetInnerHTML={{
                __html: t('chat.action.runStarted', { id: r.runId.slice(0, 8) }),
              }}
            />
          </div>
        </div>
      );
    }
    if (r?.reason === 'no_plan_yet') {
      return (
        <div className={cardClass}>
          <div className="flex items-center gap-1.5">
            <ReceiptIcon tone="info" />
            <span>{t('chat.action.noPlan')}</span>
          </div>
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
      <div className={cardClass}>
        <div className="flex items-center gap-1.5">
          <Wrench className="size-3.5 shrink-0 text-success" aria-hidden />
          <span className="text-muted-foreground">invoked skill</span>
          <span className="font-mono font-semibold">
            {r?.skillName ?? payload?.name ?? 'unknown'}
          </span>
          <span className="text-muted-foreground">
            ({tokens} tokens, {r?.durationMs ?? 0}ms)
          </span>
        </div>
      </div>
    );
  }
  if (status === 'failed') {
    const r = action.resultJson as { error?: string } | null;
    return (
      <div className={cardClass}>
        <div className="flex items-center gap-1.5 font-semibold">
          <ReceiptIcon tone="destructive" />
          {t('chat.action.actionFailed', { kind: action.kind })}
        </div>
        <div className="mt-0.5 pl-5 text-muted-foreground">
          {r?.error ?? t('chat.action.unknownError')}
        </div>
      </div>
    );
  }
  return (
    <div className={cardClass}>
      <div className="flex items-center gap-1.5">
        <ReceiptIcon tone={tone} />
        <span>{t('chat.action.generic', { kind: action.kind, status })}</span>
      </div>
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
  const { t } = useTranslation();
  const [tab, setTab] = useState<'team' | 'custom'>('team');
  const list = tab === 'team' ? team : customAgents;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();
    return () => previouslyFocused?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-[55] grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between border-b px-5 py-3">
          <h3 id={titleId} className="text-base font-semibold">
            {t('chat.addMember.title', 'Spezialist hinzufügen')}
          </h3>
          <button
            onClick={onClose}
            className="font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {t('chat.addMember.close')}
          </button>
        </header>
        <div className="flex border-b text-xs">
          <button
            onClick={() => setTab('team')}
            className={`flex-1 px-4 py-2 ${tab === 'team' ? 'border-b-2 border-info font-medium' : 'text-muted-foreground'}`}
          >
            {t('chat.addMember.tabTeam')}
          </button>
          <button
            onClick={() => setTab('custom')}
            className={`flex-1 px-4 py-2 ${tab === 'custom' ? 'border-b-2 border-info font-medium' : 'text-muted-foreground'}`}
          >
            {t('chat.addMember.tabCustom')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {tab === 'custom' ? t('chat.addMember.emptyCustom') : t('chat.addMember.emptyTeam')}
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
                <Avatar
                  name={a.name}
                  avatarUrl={a.avatarUrl ?? null}
                  color={a.color ?? null}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="truncate text-xs2 text-muted-foreground">
                    {a.description ?? ''}
                  </div>
                </div>
                {already ? (
                  <span className="text-2xs text-muted-foreground">
                    {t('chat.addMember.alreadyIn')}
                  </span>
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MessageSquare, Plus, Send, Trash2 } from 'lucide-react';
import {
  useAgents,
  useAgentThreads,
  useCreateThread,
  useDeleteThread,
  useSendMessage,
  useThreadMessages,
} from '@/api/queries';
import type { Agent, AgentThread } from '@agent-harness/schemas';

export interface AgentChatProps {
  /** Optional project context — when set, threads are created with this projectId. */
  projectId?: string | null;
  /** Compact variant (used in narrow rails). Pass `false` on full pages. */
  compact?: boolean;
}

function fmtRel(d: Date | string | number): string {
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

export function AgentChat({ projectId = null, compact = false }: AgentChatProps) {
  const agents = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [error, setError] = useState<string | null>(null);

  const threads = useAgentThreads(selectedAgentId ?? undefined);
  const messages = useThreadMessages(selectedThreadId ?? undefined);
  const createThread = useCreateThread();
  const deleteThread = useDeleteThread();
  const sendMessage = useSendMessage();

  // Pick first agent + thread by default
  useEffect(() => {
    if (!selectedAgentId && agents.data && agents.data.length > 0) {
      setSelectedAgentId(agents.data[0]?.id ?? null);
    }
  }, [selectedAgentId, agents.data]);

  useEffect(() => {
    if (!selectedThreadId && threads.data && threads.data.length > 0) {
      setSelectedThreadId(threads.data[0]?.id ?? null);
    }
    if (selectedThreadId && threads.data && !threads.data.find((t) => t.id === selectedThreadId)) {
      // Selected thread no longer belongs to current agent
      setSelectedThreadId(threads.data[0]?.id ?? null);
    }
  }, [selectedAgentId, selectedThreadId, threads.data]);

  const selectedAgent = useMemo<Agent | null>(
    () => agents.data?.find((a) => a.id === selectedAgentId) ?? null,
    [agents.data, selectedAgentId],
  );

  // auto-scroll when new messages arrive
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.data?.length, sendMessage.isPending]);

  async function startNewThread() {
    if (!selectedAgentId) return;
    try {
      const t = await createThread.mutateAsync({
        agentId: selectedAgentId,
        input: { projectId: projectId ?? null },
      });
      setSelectedThreadId(t.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteCurrentThread() {
    if (!selectedThreadId || !selectedAgentId) return;
    try {
      await deleteThread.mutateAsync({ threadId: selectedThreadId, agentId: selectedAgentId });
      setSelectedThreadId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function send() {
    if (!composer.trim() || !selectedAgentId) return;
    // Guard against double-submit while a previous send is in flight.
    // The button/textarea disabled state can lag behind rapid Cmd+Enter.
    if (sendMessage.isPending || createThread.isPending) return;
    setError(null);

    let threadId = selectedThreadId;
    if (!threadId) {
      try {
        const t = await createThread.mutateAsync({
          agentId: selectedAgentId,
          input: { projectId: projectId ?? null },
        });
        threadId = t.id;
        setSelectedThreadId(threadId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const content = composer;
    setComposer('');
    try {
      await sendMessage.mutateAsync({
        threadId: threadId!,
        agentId: selectedAgentId,
        content,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  if (agents.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents…
      </div>
    );
  }

  if (!agents.data || agents.data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <MessageSquare className="h-6 w-6 text-muted-foreground/60" />
        <div className="text-sm font-medium">No agents yet</div>
        <p className="text-xs text-muted-foreground">Create your first agent to start chatting.</p>
        <Link
          to="/agents"
          className="rounded-md border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Manage agents →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — agent picker */}
      <header className="flex flex-col gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            agent
          </span>
          <Link
            to="/agents"
            className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
          >
            manage →
          </Link>
        </div>
        <select
          value={selectedAgentId ?? ''}
          onChange={(e) => {
            setSelectedAgentId(e.target.value || null);
            setSelectedThreadId(null);
          }}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none"
        >
          {agents.data.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.name} · {a.model}
            </option>
          ))}
        </select>
      </header>

      {/* Threads list */}
      <div className="border-b border-border/60 px-3 py-2">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            threads · {threads.data?.length ?? 0}
          </span>
          <button
            onClick={startNewThread}
            disabled={createThread.isPending || !selectedAgentId}
            className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="New thread"
          >
            <Plus className="h-3 w-3" /> new
          </button>
        </div>
        <div className={`flex flex-col gap-1 overflow-y-auto ${compact ? 'max-h-32' : 'max-h-48'}`}>
          {threads.data && threads.data.length > 0 ? (
            threads.data
              .slice(0, 8)
              .map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  active={selectedThreadId === t.id}
                  onClick={() => setSelectedThreadId(t.id)}
                />
              ))
          ) : (
            <div className="text-[11px] italic text-muted-foreground/60">
              no threads — type below to start one.
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {selectedAgent && (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
            <span className="font-medium">@{selectedAgent.name}</span>
            {selectedAgent.description && <> · {selectedAgent.description}</>}
            <div className="mt-0.5 line-clamp-2 font-mono text-[10px] opacity-70">
              {selectedAgent.systemPrompt.slice(0, 140)}
              {selectedAgent.systemPrompt.length > 140 ? '…' : ''}
            </div>
          </div>
        )}
        {messages.data && messages.data.length > 0
          ? messages.data.map((m) => <MessageBubble key={m.id} message={m} agent={selectedAgent} />)
          : !sendMessage.isPending && (
              <div className="my-auto text-center text-[12px] italic text-muted-foreground/70">
                Type a message below to start the conversation.
              </div>
            )}
        {sendMessage.isPending && (
          <div className="flex items-center gap-2 self-start rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {selectedAgent ? `@${selectedAgent.name}` : 'agent'} is thinking…
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <footer className="flex flex-col gap-1.5 border-t border-border/60 p-3">
        <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>{selectedAgent ? `to @${selectedAgent.name}` : 'select an agent'}</span>
          <span>cmd+enter</span>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={handleKey}
            disabled={!selectedAgentId || sendMessage.isPending}
            rows={compact ? 2 : 3}
            placeholder={
              selectedThreadId
                ? 'reply…'
                : selectedAgent
                  ? `start a new thread with @${selectedAgent.name}`
                  : 'pick an agent above'
            }
            className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-info disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={!composer.trim() || !selectedAgentId || sendMessage.isPending}
            className="grid h-9 w-9 flex-none place-items-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
            aria-label="Send"
          >
            {sendMessage.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
        {selectedThreadId && (
          <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/80">
            <span>{messages.data?.length ?? 0} messages in this thread</span>
            <button
              onClick={() => void deleteCurrentThread()}
              disabled={deleteThread.isPending}
              className="flex items-center gap-1 hover:text-destructive disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              delete thread
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  onClick,
}: {
  thread: AgentThread;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-xs ${active ? 'bg-info/15 text-info-foreground' : 'hover:bg-muted'}`}
    >
      <span className="truncate flex-1">{thread.title ?? `thread ${thread.id.slice(0, 6)}`}</span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {fmtRel(thread.updatedAt as Date | string | number)}
      </span>
    </button>
  );
}

function MessageBubble({
  message,
  agent,
}: {
  message: import('@agent-harness/schemas').AgentMessage;
  agent: Agent | null;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[90%] rounded-lg border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'border-info/30 bg-info/10 text-foreground'
            : message.errorReason
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-border bg-card'
        }`}
      >
        {message.errorReason ? (
          <span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
              {message.errorReason}
            </span>
            {message.content ? (
              <>
                <br />
                {message.content}
              </>
            ) : null}
          </span>
        ) : (
          message.content
        )}
      </div>
      <div className="flex items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
        <span>{isUser ? 'you' : `@${agent?.name ?? 'agent'}`}</span>
        {message.tokensIn != null && message.tokensOut != null && (
          <span>· {message.tokensIn + message.tokensOut} tok</span>
        )}
        {message.durationMs != null && message.durationMs > 0 && (
          <span>· {(message.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    </div>
  );
}

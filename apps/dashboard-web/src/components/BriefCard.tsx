import { forwardRef, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, ChevronUp, Send, Sparkles } from 'lucide-react';
import {
  useFinalizeInterview,
  useInterview,
  useProject,
  useSendInterviewMessage,
  type InterviewTranscriptMessage,
  type ProjectBriefRow,
} from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';

interface BriefCardProps {
  projectId: string;
  /**
   * If true, the card always renders the chat surface. When false (default)
   * a finalised brief renders collapsed with an "Edit"-style expand toggle.
   */
  forceExpanded?: boolean;
}

export function BriefCard({ projectId, forceExpanded = false }: BriefCardProps) {
  const { t } = useTranslation();
  const interview = useInterview(projectId);
  const sendMessage = useSendInterviewMessage(projectId);
  const finalize = useFinalizeInterview(projectId);
  const project = useProject(projectId);
  const [draft, setDraft] = useState('');
  const [expandedAfterReady, setExpandedAfterReady] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const brief = interview.data?.brief ?? null;
  const transcript = interview.data?.transcript ?? [];
  const isReady = brief?.briefReady ?? false;
  // A finalized brief is 100% complete by definition. Guard here (not just on the
  // server) so briefs finalized before this fix — or via goal-as-brief, which
  // never raised the score — never show the contradictory "Finalisiert" + "0%".
  const score = isReady ? 100 : (brief?.completenessScore ?? 0);
  const goal = project.data?.goal ?? '';
  const expanded = forceExpanded || !isReady || expandedAfterReady;

  useEffect(() => {
    if (!expanded) return;
    const el = transcriptRef.current;
    if (!el || typeof el.scrollTo !== 'function') return;
    el.scrollTo({ top: el.scrollHeight });
  }, [transcript.length, expanded]);

  const handleSend = async (): Promise<void> => {
    const message = draft.trim();
    if (!message || sendMessage.isPending) return;
    setDraft('');
    try {
      await sendMessage.mutateAsync(message);
    } catch (err) {
      toast({
        title: t('briefCard.toasts.sendFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
      setDraft(message);
    }
  };

  const handleFinalize = async (): Promise<void> => {
    if (finalize.isPending) return;
    try {
      const res = await finalize.mutateAsync();
      if (res.prdWriteError) {
        toast({
          title: t('briefCard.toasts.finalizedWithWarning'),
          description: res.prdWriteError,
        });
      } else {
        toast({ title: t('briefCard.toasts.finalized') });
      }
    } catch (err) {
      toast({
        title: t('briefCard.toasts.finalizeFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  if (interview.isLoading) {
    return (
      <Card data-testid="brief-card-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            {t('briefCard.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{t('buttons.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  if (interview.isError) {
    return (
      <Card data-testid="brief-card-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            {t('briefCard.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{t('briefCard.loadError')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="brief-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div className="flex flex-1 flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            {t('briefCard.title')}
            {isReady ? (
              <Badge variant="secondary" className="text-2xs">
                <Check className="mr-1 h-3 w-3" />
                {t('briefCard.statusReady')}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-2xs" data-testid="brief-status-pending">
                {t('briefCard.statusPending')}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            {isReady ? t('briefCard.descriptionReady') : t('briefCard.descriptionPending')}
          </CardDescription>
        </div>
        {isReady && !forceExpanded ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpandedAfterReady((v) => !v)}
            data-testid="brief-toggle-expand"
            className="h-7 px-2 text-xs"
          >
            {expandedAfterReady ? (
              <>
                <ChevronUp className="mr-1 h-3 w-3" />
                {t('briefCard.collapse')}
              </>
            ) : (
              <>
                <ChevronDown className="mr-1 h-3 w-3" />
                {t('briefCard.expand')}
              </>
            )}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Progress
            value={score}
            className="h-2"
            data-testid="brief-progress"
            aria-label={t('briefCard.completeness')}
          />
          <span className="font-mono text-xs text-muted-foreground" data-testid="brief-score">
            {score}%
          </span>
        </div>

        {!isReady ? (
          <p
            className="rounded-md border bg-muted/30 px-3 py-2 text-xs leading-snug text-muted-foreground"
            data-testid="brief-explainer"
          >
            {t('briefCard.explainer')}
          </p>
        ) : null}

        {brief ? <BriefSummary brief={brief} /> : null}

        {expanded ? (
          <>
            {!isReady && goal ? (
              <div
                className="rounded-md border bg-muted/30 px-3 py-2 text-xs"
                data-testid="brief-goal-context"
              >
                <span className="font-medium">{t('briefCard.goalLabel')}:</span> {goal}
              </div>
            ) : null}
            <Transcript
              transcript={transcript}
              ref={transcriptRef}
              onPickExample={(q) => setDraft(q)}
            />
            {!isReady ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={t('briefCard.inputPlaceholder')}
                  data-testid="brief-message-input"
                  disabled={sendMessage.isPending}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleSend()}
                    disabled={sendMessage.isPending || draft.trim() === ''}
                    data-testid="brief-send-button"
                  >
                    <Send className="mr-1 h-3 w-3" />
                    {sendMessage.isPending ? t('briefCard.sending') : t('briefCard.send')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleFinalize()}
                    disabled={finalize.isPending}
                    data-testid="brief-finalize-button"
                    title={
                      score < 1
                        ? t('briefCard.useGoalAsBriefHint')
                        : score < 50
                          ? t('briefCard.finalizeEarlyHint')
                          : t('briefCard.finalizeHint')
                    }
                  >
                    {finalize.isPending
                      ? t('briefCard.finalizing')
                      : score < 1
                        ? t('briefCard.useGoalAsBrief')
                        : t('briefCard.finalize')}
                  </Button>
                  <span className="text-2xs text-muted-foreground">
                    {t('briefCard.keyboardHint')}
                  </span>
                </div>
                <p className="text-2xs text-muted-foreground" data-testid="brief-required-hint">
                  {t('briefCard.requiredHint')}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BriefSummary({ brief }: { brief: ProjectBriefRow }) {
  const { t } = useTranslation();
  const rows: Array<{ key: string; label: string; value: string | null }> = [
    {
      key: 'platform',
      label: t('briefCard.fields.platform'),
      value: brief.platform,
    },
    {
      key: 'targetAudience',
      label: t('briefCard.fields.targetAudience'),
      value: brief.targetAudience,
    },
    {
      key: 'successCriteria',
      label: t('briefCard.fields.successCriteria'),
      value: brief.successCriteria,
    },
    {
      key: 'designPrefs',
      label: t('briefCard.fields.designPrefs'),
      value: brief.designPrefs,
    },
    {
      key: 'constraints',
      label: t('briefCard.fields.constraints'),
      value: brief.constraints,
    },
  ];
  const present = rows.filter((r) => r.value && r.value.trim() !== '');
  if (present.length === 0) return null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2" data-testid="brief-summary">
      {present.map((r) => (
        <div key={r.key} className="flex flex-col gap-0.5">
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{r.label}</dt>
          <dd className="text-xs leading-snug">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface TranscriptProps {
  transcript: InterviewTranscriptMessage[];
  /** Fill the message box with an example question (does not auto-send). */
  onPickExample?: (question: string) => void;
}

const Transcript = forwardRef<HTMLDivElement, TranscriptProps>(function Transcript(
  { transcript, onPickExample },
  ref,
) {
  const { t } = useTranslation();
  if (transcript.length === 0) {
    const examples = [
      t('briefCard.welcome.examples.audience'),
      t('briefCard.welcome.examples.features'),
      t('briefCard.welcome.examples.design'),
    ];
    return (
      <div
        ref={ref}
        className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-md border bg-muted/20 px-3 py-3"
        data-testid="brief-transcript-empty"
      >
        <div className="max-w-[90%] rounded-md border bg-background px-3 py-2 text-xs">
          <p className="mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            <Bot className="h-3 w-3" />
            {t('briefCard.assistantName')}
          </p>
          <p className="leading-snug">{t('briefCard.welcome.greeting')}</p>
          <p className="mt-2 leading-snug text-muted-foreground">{t('briefCard.welcome.prompt')}</p>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="brief-welcome-examples">
          {examples.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onPickExample?.(q)}
              className="rounded-full border bg-background px-3 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="brief-example-chip"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border bg-muted/20 px-3 py-3"
      data-testid="brief-transcript"
    >
      {transcript.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}
    </div>
  );
});

function Bubble({ message }: { message: InterviewTranscriptMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  return (
    <div
      className={isUser ? 'flex justify-end' : 'flex justify-start'}
      data-testid={`brief-bubble-${message.role}`}
    >
      <div
        className={
          isUser
            ? 'max-w-[80%] rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground'
            : 'max-w-[80%] rounded-md border bg-background px-3 py-2 text-xs'
        }
      >
        {!isUser && (
          <p className="mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            <Bot className="h-3 w-3" />
            {t('briefCard.assistantName')}
          </p>
        )}
        <p className="whitespace-pre-wrap leading-snug">{message.content}</p>
      </div>
    </div>
  );
}

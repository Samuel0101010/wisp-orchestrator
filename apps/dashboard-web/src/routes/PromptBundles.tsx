import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Database, Flame, X, Zap } from 'lucide-react';
import { usePromptBundles, useDeletePromptBundle, type PromptBundleRow } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/ui/error-banner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fmtRel } from '@/lib/fmt-rel';

const TONES = ['coral', 'mint', 'sky', 'amber', 'rose'] as const;
type Tone = (typeof TONES)[number];

function toneFor(key: string): Tone {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length]!;
}

// Liveness classification only — the human-readable label comes from the
// shared, locale-correct fmtRel() (Intl.RelativeTimeFormat). hot = used within
// the last 30 min; stale = not used for 7+ days. `nowMs` is snapshotted once
// per render so every card + KPI reads the same clock.
function bundleAge(
  input: number | string,
  nowMs: number,
): { hot: boolean; stale: boolean; valid: boolean } {
  const ms = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(ms)) return { hot: false, stale: false, valid: false };
  const delta = Math.max(0, nowMs - ms);
  return { hot: delta < 30 * 60_000, stale: delta >= 7 * 86_400_000, valid: true };
}

function shortHash(s: string): string {
  if (!s) return '—';
  if (s.length <= 8) return s;
  return s.slice(0, 6) + '…';
}

/**
 * Pick the most descriptive segment of a working-directory path.
 * Walks from the end and skips hash-like segments (≥12 chars, hex-only)
 * — the harness temp dirs end in such segments, so we want the parent's
 * name instead of the digest. Returns '' when no descriptive segment is
 * found so the caller can fall back to a bundle-hash label.
 */
function cwdBasename(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.length < 12 || !/^[0-9a-f]+$/i.test(p)) return p;
  }
  return '';
}

function MiniKpi({
  label,
  value,
  sub,
  tone,
  Icon,
  testId,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone: Tone | 'ink';
  Icon: typeof Zap;
  testId?: string;
}) {
  const iconColor = tone === 'ink' ? 'var(--wisp-ink-3)' : `var(--${tone})`;
  return (
    <div className="wisp-card" data-testid={testId}>
      <div className="t-eyebrow mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" style={{ color: iconColor }} aria-hidden />
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{ fontFamily: 'var(--f-head)', fontSize: 22, fontWeight: 500, lineHeight: 1 }}
      >
        {value}
      </div>
      {sub && <div className="t-dim mt-1.5 text-xs">{sub}</div>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="t-eyebrow" style={{ paddingTop: 1 }}>
        {k}
      </span>
      <span
        className="t-mono"
        style={{
          fontSize: 12,
          color: 'var(--wisp-ink-2)',
          maxWidth: '65%',
          textAlign: 'right',
          wordBreak: 'break-word',
        }}
      >
        {v}
      </span>
    </div>
  );
}

/**
 * BundleCard — design-parity rendering. Layout mirrors `BundleCard` in the
 * Wisp design (sections-b.jsx): tone-keyed icon block + name + short id,
 * 2×2 KV pair grid, divider, last-used + hits row with an Instrument-Serif
 * hits number. The design has no per-card action; invalidate is exposed
 * via a hover-revealed icon button so the visual stays clean.
 */
function BundleCard({
  bundle,
  onInvalidate,
  busy,
  nowMs,
}: {
  bundle: PromptBundleRow;
  onInvalidate: (key: string) => void;
  busy: boolean;
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  const age = bundleAge(bundle.lastUsedAt, nowMs);
  const label = age.valid ? fmtRel(bundle.lastUsedAt, i18n.language) : '—';
  const tone = toneFor(bundle.bundleKey);
  const cwdLabel = cwdBasename(bundle.cwd);
  const displayName = cwdLabel || `bundle ${shortHash(bundle.bundleKey)}`;
  const subId = shortHash(bundle.bundleKey);
  const session = bundle.claudeSessionId ? bundle.claudeSessionId.slice(0, 8) : '—';

  return (
    <div
      className="wisp-card wisp-lift group relative"
      style={{ padding: 16 }}
      data-testid={`bundle-card-${bundle.bundleKey.slice(0, 8)}`}
    >
      {age.hot && (
        <div
          className="absolute top-3 right-3 flex items-center gap-1"
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: 'hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.16)',
            color: 'hsl(var(--coral-h) var(--coral-s) 78%)',
            fontSize: 10,
            border: '1px solid hsl(var(--coral-h) var(--coral-s) var(--coral-l) / 0.3)',
          }}
        >
          <span className="wisp-dot coral pulse" style={{ width: 5, height: 5 }} />
          {t('promptBundles.cols.hot', 'hot')}
        </div>
      )}

      {/* Header — icon + name + short id */}
      <div className="mb-2.5 flex items-center gap-2.5" style={{ paddingRight: age.hot ? 56 : 0 }}>
        <div
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'var(--wisp-glass-strong)',
            border: '1px solid var(--wisp-hairline-strong)',
            color: `var(--${tone})`,
          }}
        >
          <Database className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate"
            style={{ fontFamily: 'var(--f-head)', fontSize: 14, fontWeight: 500 }}
            title={cwdLabel ? bundle.cwd : bundle.bundleKey}
          >
            {displayName}
          </div>
          <div className="t-mono t-faint" style={{ fontSize: 11 }}>
            {subId}
          </div>
        </div>
      </div>

      {/* 2×2 KV grid. Maps the design's model/tools/size/hash onto our
          available data (we don't store tools count or system-prompt size
          per bundle, so session/cwd are the most informative proxies). */}
      <div className="mb-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <KV k={t('promptBundles.cols.model', 'model')} v={bundle.model} />
        <KV k={t('promptBundles.cols.session', 'session')} v={session} />
        <KV k={t('promptBundles.cols.cwd', 'cwd')} v={cwdLabel || '—'} />
        <KV k={t('promptBundles.cols.hash', 'hash')} v={subId} />
      </div>

      <div className="my-2 h-px" style={{ background: 'var(--wisp-hairline)' }} />

      {/* Bottom row: last-used + hits + (hover-revealed) invalidate. */}
      <div className="flex items-center justify-between">
        <div>
          <div className="t-faint" style={{ fontSize: 10.5 }}>
            {t('promptBundles.cols.lastUsed', 'last used')}
          </div>
          <div
            className="flex items-center gap-1 tabular-nums"
            style={{
              fontSize: 12,
              color: age.stale ? 'var(--amber)' : 'var(--wisp-ink-2)',
            }}
          >
            {age.stale && <Clock className="h-3 w-3 shrink-0" aria-hidden />}
            {label}
          </div>
        </div>
        <div className="text-right">
          <div className="t-faint" style={{ fontSize: 10.5 }}>
            {t('promptBundles.cols.hits', 'hits')}
          </div>
          <div
            className="tabular-nums"
            style={{ fontFamily: 'var(--f-display)', fontSize: 20, lineHeight: 1 }}
          >
            {bundle.hitCount}
          </div>
        </div>
      </div>

      {/* Hover-revealed invalidate (the design has no per-card action; this
          stays out of the resting visual but keeps the destructive control
          discoverable). */}
      <button
        type="button"
        onClick={() => onInvalidate(bundle.bundleKey)}
        disabled={busy}
        aria-label={t('promptBundles.actions.invalidate', 'Invalidate bundle')}
        title={t('promptBundles.actions.invalidateTitle', 'Invalidate')}
        className="wisp-btn icon ghost absolute bottom-3 left-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        style={{
          color: 'hsl(var(--rose-h) var(--rose-s) 80%)',
        }}
      >
        {busy ? <span className="t-mono text-xs">…</span> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function PromptBundlesRoute() {
  const { t } = useTranslation();
  const q = usePromptBundles();
  const del = useDeletePromptBundle();
  const [inflight, setInflight] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Keep the confirm dialog open (buttons disabled via `busy`) while a bulk
  // invalidate is in flight, then auto-dismiss once every delete has settled.
  useEffect(() => {
    if (bulkRunning && inflight.size === 0) {
      setBulkRunning(false);
      setConfirmAll(false);
    }
  }, [bulkRunning, inflight.size]);

  const invalidate = (key: string): void => {
    setInflight((prev) => new Set(prev).add(key));
    del.mutate(key, {
      onSettled: () =>
        setInflight((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        }),
    });
  };

  const rows = q.data ?? [];
  // Snapshot once per render so every card + KPI reads the same clock.
  const nowMs = Date.now();

  // Honest aggregates only — every value is derived from real bundle fields
  // (hitCount / lastUsedAt). The former "tokens saved" + "cache hit rate"
  // ribbon was fabricated (tuned constants), so it was removed.
  const totalHits = rows.reduce((s, r) => s + r.hitCount, 0);
  let hot = 0;
  let stale = 0;
  for (const r of rows) {
    const age = bundleAge(r.lastUsedAt, nowMs);
    if (age.hot) hot++;
    if (age.stale) stale++;
  }

  return (
    <div className="wisp-fade-up flex flex-col gap-5">
      {/* Header */}
      <header className="flex items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="t-eyebrow mb-1">{t('promptBundles.eyebrow', 'Warm session cache')}</div>
          <div className="flex items-baseline gap-2.5">
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--f-display)',
                fontSize: 28,
                fontWeight: 400,
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {t('promptBundles.title')}
            </h1>
            <span className="tabular-nums text-sm text-[color:var(--wisp-ink-3)]">
              {t('promptBundles.subtitle', { count: rows.length })}
            </span>
          </div>
          <div className="mt-1.5 max-w-2xl text-sm-tight text-[color:var(--wisp-ink-3)]">
            {t('promptBundles.explanation')}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="wisp-btn ghost"
            onClick={() => setConfirmAll(true)}
            disabled={!rows.length || inflight.size > 0}
          >
            {t('promptBundles.actions.invalidateAll', 'Invalidate all')}
          </button>
        </div>
      </header>

      {/* KPI ribbon — honest aggregates derived from real bundle fields. */}
      <div
        className="grid gap-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
      >
        <MiniKpi
          label={t('promptBundles.kpis.totalHits', 'Total hits')}
          value={totalHits}
          sub={t('promptBundles.kpis.totalHitsSub', { count: rows.length })}
          tone="ink"
          Icon={Zap}
          testId="kpi-total-hits"
        />
        <MiniKpi
          label={t('promptBundles.kpis.hotBundles', 'Hot')}
          value={hot}
          sub={t('promptBundles.kpis.hotSub', 'recently used')}
          tone="coral"
          Icon={Flame}
          testId="kpi-hot"
        />
        <MiniKpi
          label={t('promptBundles.kpis.stale', 'Stale')}
          value={stale}
          sub={t('promptBundles.kpis.staleSub', 'not used 7d+')}
          tone="amber"
          Icon={Clock}
          testId="kpi-stale"
        />
      </div>

      {/* Card grid — auto-fill so cards stay at ≥320px and arrange themselves
          based on available width, matching the design's CSS grid. */}
      {q.isLoading ? (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="wisp-card" style={{ padding: 16 }}>
              <Skeleton className="mb-3 h-9 w-9 rounded-lg" />
              <Skeleton className="mb-2 h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : q.error ? (
        <ErrorBanner
          title={t('promptBundles.loadFailed')}
          message={t('errors.retryHint')}
          onRetry={() => q.refetch()}
        />
      ) : rows.length === 0 ? (
        <div className="wisp-card flex items-center justify-center" style={{ padding: 40 }}>
          <div className="text-center">
            <div
              className="mx-auto mb-3 flex items-center justify-center"
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: 'var(--wisp-glass-strong)',
                border: '1px solid var(--wisp-hairline-strong)',
                color: 'var(--coral)',
              }}
            >
              <Database className="h-5 w-5" />
            </div>
            <div className="mb-1" style={{ fontFamily: 'var(--f-display)', fontSize: 22 }}>
              {t('promptBundles.emptyTitle')}
            </div>
            <div className="t-dim" style={{ fontSize: 13, maxWidth: 360, margin: '0 auto' }}>
              {t('promptBundles.emptyDescription')}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
          data-testid="bundles-grid"
        >
          {rows.map((b) => (
            <BundleCard
              key={b.bundleKey}
              bundle={b}
              onInvalidate={invalidate}
              busy={inflight.has(b.bundleKey)}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('promptBundles.confirmInvalidateAll.title', 'Invalidate all bundles?')}
        description={t(
          'promptBundles.confirmInvalidateAll.description',
          'This drops all {{count}} cached bundles. The next session re-warms the cache from scratch.',
          { count: rows.length },
        )}
        confirmLabel={t('promptBundles.confirmInvalidateAll.confirm', 'Invalidate all')}
        cancelLabel={t('promptBundles.confirmInvalidateAll.cancel', 'Cancel')}
        destructive
        busy={bulkRunning}
        onConfirm={() => {
          setBulkRunning(true);
          for (const r of rows) invalidate(r.bundleKey);
        }}
      />
    </div>
  );
}

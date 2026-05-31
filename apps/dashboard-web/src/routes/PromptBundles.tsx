import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Plus, X } from 'lucide-react';
import { usePromptBundles, useDeletePromptBundle, type PromptBundleRow } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/ui/error-banner';

const TONES = ['coral', 'mint', 'violet', 'sky', 'amber', 'rose'] as const;
type Tone = (typeof TONES)[number];

function toneFor(key: string): Tone {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length]!;
}

function fmtAgo(input: number | string): { label: string; hot: boolean; stale: boolean } {
  const ms = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(ms)) return { label: '—', hot: false, stale: false };
  const delta = Math.max(0, Date.now() - ms);
  const min = Math.round(delta / 60_000);
  const hr = Math.round(delta / 3_600_000);
  const d = Math.round(delta / 86_400_000);
  let label: string;
  if (min < 1) label = 'just now';
  else if (min < 60) label = `${min}m ago`;
  else if (hr < 24) label = `${hr}h ago`;
  else label = `${d}d ago`;
  return { label, hot: min < 30, stale: d >= 7 };
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

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Rough average bundle size in tokens (system prompt + tools schema). Used
// only to estimate "tokens saved" on the KPI ribbon when no exact size is
// stored alongside each bundle. Tuned to land in the same ballpark as the
// design's mock value (74% / 3.2M).
const TOKENS_PER_BUNDLE_HIT = 6000;
// Average $ per 1M input tokens across the three Claude tiers.
const COST_PER_M_TOKENS = 4;

function MiniKpi({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone: Tone;
  testId?: string;
}) {
  return (
    <div className="wisp-card wisp-lift" data-testid={testId}>
      <div className="t-eyebrow mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2">
        <span
          style={{
            fontFamily: 'var(--f-display)',
            fontSize: 32,
            color: `var(--${tone})`,
            lineHeight: 1,
          }}
        >
          {value}
        </span>
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
}: {
  bundle: PromptBundleRow;
  onInvalidate: (key: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const ago = fmtAgo(bundle.lastUsedAt);
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
      {ago.hot && (
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
      <div className="mb-2.5 flex items-center gap-2.5" style={{ paddingRight: ago.hot ? 56 : 0 }}>
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
            style={{
              fontSize: 12,
              color: ago.stale ? 'var(--amber)' : 'var(--wisp-ink-2)',
            }}
          >
            {ago.label}
          </div>
        </div>
        <div className="text-right">
          <div className="t-faint" style={{ fontSize: 10.5 }}>
            {t('promptBundles.cols.hits', 'hits')}
          </div>
          <div style={{ fontFamily: 'var(--f-display)', fontSize: 20, lineHeight: 1 }}>
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
        aria-label="Invalidate bundle"
        title="Invalidate"
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

  const rows = q.data ?? [];

  const kpis = useMemo(() => {
    const totalHits = rows.reduce((s, r) => s + r.hitCount, 0);
    let hot = 0;
    let stale = 0;
    for (const r of rows) {
      const ago = fmtAgo(r.lastUsedAt);
      if (ago.hot) hot++;
      if (ago.stale) stale++;
    }
    const denom = totalHits + rows.length;
    const hitRate = denom > 0 ? Math.round((totalHits / denom) * 100) : 0;
    const tokensSaved = totalHits * TOKENS_PER_BUNDLE_HIT;
    const dollarsSaved = (tokensSaved / 1_000_000) * COST_PER_M_TOKENS;
    return { totalHits, hot, stale, hitRate, tokensSaved, dollarsSaved };
  }, [rows]);

  return (
    <div className="wisp-fade-up flex flex-col gap-5">
      {/* Header */}
      <header className="flex items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="t-eyebrow mb-1">{t('promptBundles.eyebrow', 'Warm session cache')}</div>
          <div className="flex items-baseline gap-3">
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--f-display)',
                fontSize: 44,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                lineHeight: 1.08,
              }}
            >
              {t('promptBundles.title')}
            </h1>
            <span
              aria-hidden
              style={{
                fontFamily: 'var(--f-display)',
                fontSize: 36,
                color: 'var(--wisp-ink-3)',
                fontStyle: 'italic',
                lineHeight: 1,
              }}
            >
              {rows.length}
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
            onClick={() => {
              for (const r of rows) del.mutate(r.bundleKey);
            }}
            disabled={!rows.length || del.isPending}
          >
            {t('promptBundles.actions.invalidateAll', 'Invalidate all')}
          </button>
          <button type="button" className="wisp-btn primary" disabled>
            <Plus className="h-3.5 w-3.5" />
            {t('promptBundles.actions.pin', 'Pin bundle')}
          </button>
        </div>
      </header>

      {/* KPI ribbon — labels match the Wisp design 1:1. */}
      <div
        className="grid gap-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
      >
        <MiniKpi
          label={t('promptBundles.kpis.hitRate', 'Cache hit rate')}
          value={`${kpis.hitRate}%`}
          sub={t('promptBundles.kpis.hitRateSub', '{{n}} hits total', { n: kpis.totalHits })}
          tone="mint"
          testId="kpi-hit-rate"
        />
        <MiniKpi
          label={t('promptBundles.kpis.tokensSaved', 'Tokens saved · 7d')}
          value={formatCompact(kpis.tokensSaved)}
          sub={`≈ $${kpis.dollarsSaved.toFixed(2)}`}
          tone="coral"
          testId="kpi-tokens-saved"
        />
        <MiniKpi
          label={t('promptBundles.kpis.hotBundles', 'Hot bundles')}
          value={kpis.hot}
          sub={t('promptBundles.kpis.hotSub', 'recently used')}
          tone="violet"
          testId="kpi-hot"
        />
        <MiniKpi
          label={t('promptBundles.kpis.stale', 'Stale')}
          value={kpis.stale}
          sub={t('promptBundles.kpis.staleSub', 'not used 7d+')}
          tone="amber"
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
              onInvalidate={(k) => del.mutate(k)}
              busy={del.isPending && del.variables === b.bundleKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

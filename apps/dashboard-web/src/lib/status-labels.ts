import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDollarSign,
  CircleSlash,
  Clock,
  Loader2,
  Lock,
  CircleMinus,
  Pause,
  PencilLine,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { StatusPillTone } from '@/components/ui/status-pill';

export function statusLabel(status: string, t: TFunction): string {
  const key = `status.${status}`;
  // i18next returns the key itself when missing; explicit fallback to the raw status.
  const translated = t(key, { defaultValue: status });
  return translated;
}

export interface StatusMeta {
  tone: StatusPillTone;
  Icon: LucideIcon;
  /** in-progress / live state — drives StatusPill's pulsing dot. */
  live: boolean;
}

/**
 * Canonical status -> {tone, Icon, live} map shared by every surface that
 * renders a lifecycle status (runs, tasks, plans, run outcomes, worker runs,
 * verify verdicts, change-requests). Pairing colour with an icon is what keeps
 * status from being conveyed by colour alone (WCAG 2.2 / DESIGN.md color-blind
 * requirement). Render through StatusPill:
 *   const { tone, Icon, live } = statusMeta(status);
 *   <StatusPill tone={tone} live={live} icon={<Icon className="size-3" />}>
 *     {statusLabel(status, t)}
 *   </StatusPill>
 */
const STATUS_META: Record<string, StatusMeta> = {
  // in progress
  running: { tone: 'info', Icon: Loader2, live: true },
  'in-run': { tone: 'info', Icon: Loader2, live: true },
  // waiting / not yet started
  pending: { tone: 'neutral', Icon: Clock, live: false },
  ready: { tone: 'neutral', Icon: CircleDashed, live: false },
  draft: { tone: 'neutral', Icon: PencilLine, live: false },
  paused: { tone: 'warning', Icon: Pause, live: false },
  locked: { tone: 'info', Icon: Lock, live: false },
  // success
  completed: { tone: 'success', Icon: CheckCircle2, live: false },
  done: { tone: 'success', Icon: CheckCircle2, live: false },
  success: { tone: 'success', Icon: CheckCircle2, live: false },
  ok: { tone: 'success', Icon: CheckCircle2, live: false },
  pass: { tone: 'success', Icon: CheckCircle2, live: false },
  // failure
  failed: { tone: 'destructive', Icon: XCircle, live: false },
  failure: { tone: 'destructive', Icon: XCircle, live: false },
  fail: { tone: 'destructive', Icon: XCircle, live: false },
  error: { tone: 'destructive', Icon: AlertTriangle, live: false },
  budget_exceeded: { tone: 'destructive', Icon: CircleDollarSign, live: false },
  // neutral terminal states
  cancelled: { tone: 'neutral', Icon: CircleSlash, live: false },
  skipped: { tone: 'neutral', Icon: CircleMinus, live: false },
  dismissed: { tone: 'neutral', Icon: CircleSlash, live: false },
};

const FALLBACK_META: StatusMeta = { tone: 'neutral', Icon: Clock, live: false };

/**
 * Look up the tone + icon + live flag for a status string. Unknown values get a
 * safe neutral, non-live fallback (still an icon, never colour-only).
 */
export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? FALLBACK_META;
}

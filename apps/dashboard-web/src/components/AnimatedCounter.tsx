import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface AnimatedCounterProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: number;
  /** Animation duration in ms. Defaults to 1100ms. */
  durationMs?: number;
  /** Custom number formatter. Defaults to en-US thousands separator. */
  format?: (n: number) => string;
  className?: string;
  /** Disable animation explicitly (in addition to prefers-reduced-motion). */
  noAnimate?: boolean;
}

const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);

const defaultFormat = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Counts up from the previously rendered value to `value` over `durationMs`,
 * easing with easeOutQuart. Uses requestAnimationFrame, respects
 * prefers-reduced-motion (snaps to final value), and renders monospace tabular-nums
 * for stable column widths.
 */
export function AnimatedCounter({
  value,
  durationMs = 1100,
  format = defaultFormat,
  className,
  noAnimate,
  ...rest
}: AnimatedCounterProps) {
  const prevRef = useRef(value);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setDisplay(value);
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (noAnimate || reduced || durationMs <= 0) {
      prevRef.current = value;
      setDisplay(value);
      return;
    }
    const start = prevRef.current;
    const delta = value - start;
    if (delta === 0) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      setDisplay(start + delta * easeOutQuart(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      prevRef.current = value;
    };
  }, [value, durationMs, noAnimate]);

  return (
    <span className={cn('tabular-nums', className)} data-value={value} {...rest}>
      {format(display)}
    </span>
  );
}

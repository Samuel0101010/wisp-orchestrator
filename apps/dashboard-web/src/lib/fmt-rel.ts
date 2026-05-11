/**
 * Format an absolute timestamp as a relative time string in the active
 * locale. Threshold ladder: <60s seconds, <1h minutes, <1d hours, else days.
 * `Intl.RelativeTimeFormat` handles all locale-specific formatting (en: "5
 * minutes ago" / de: "vor 5 Minuten") so we don't need t() here.
 *
 * Pass the active language from i18next, e.g. via `useTranslation().i18n.language`.
 */
export function fmtRel(d: Date | string | number, lang: string): string {
  const ms = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const dt = Date.now() - ms;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (dt < 60_000) return rtf.format(-Math.floor(dt / 1000), 'second');
  if (dt < 3_600_000) return rtf.format(-Math.floor(dt / 60_000), 'minute');
  if (dt < 86_400_000) return rtf.format(-Math.floor(dt / 3_600_000), 'hour');
  return rtf.format(-Math.floor(dt / 86_400_000), 'day');
}

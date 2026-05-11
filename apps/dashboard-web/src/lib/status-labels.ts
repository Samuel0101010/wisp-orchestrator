import type { TFunction } from 'i18next';

export function statusLabel(status: string, t: TFunction): string {
  const key = `status.${status}`;
  // i18next returns the key itself when missing; explicit fallback to the raw status.
  const translated = t(key, { defaultValue: status });
  return translated;
}

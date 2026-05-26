import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Escape user-controlled values before interpolating into i18n strings that
 * carry static HTML markup (e.g. `<strong>{{name}}</strong>`) and are then
 * passed to dangerouslySetInnerHTML. The i18n config uses
 * `interpolation.escapeValue: false` to allow the static markup, which leaves
 * dynamic values raw — so we escape at the call site.
 */
export function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

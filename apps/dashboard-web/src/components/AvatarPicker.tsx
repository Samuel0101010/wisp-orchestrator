/**
 * Avatar picker — modal grid of 20 generic preset photos plus "no avatar"
 * (initials fallback). Used in the Agents tab edit modal.
 *
 * The preset filenames are produced by scripts/download-avatars.mjs:
 *   /avatars/generic-01.jpg … /avatars/generic-20.jpg
 */
import { useTranslation } from 'react-i18next';
import { Avatar } from './Avatar';

const GENERIC = Array.from({ length: 20 }, (_, i) => ({
  url: `/avatars/generic-${String(i + 1).padStart(2, '0')}.jpg`,
}));

export interface AvatarPickerProps {
  open: boolean;
  selected?: string | null;
  /** The agent's name — used for the initials-fallback preview tile. */
  name: string;
  onSelect: (avatarUrl: string | null) => void;
  onClose: () => void;
}

export function AvatarPicker({ open, selected, name, onSelect, onClose }: AvatarPickerProps) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between border-b px-5 py-3">
          <h3 className="text-base font-semibold">{t('avatarPicker.title')}</h3>
          <button
            onClick={onClose}
            className="font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {t('avatarPicker.close')}
          </button>
        </header>
        <div className="grid grid-cols-6 gap-3 overflow-auto p-5">
          {/* No avatar (initials) tile */}
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              onClose();
            }}
            className={`group flex flex-col items-center gap-1 rounded-lg p-2 transition-colors hover:bg-accent ${
              !selected ? 'bg-accent ring-2 ring-info' : ''
            }`}
            title={t('avatarPicker.initialsTitle')}
          >
            <Avatar name={name} avatarUrl={null} size={56} decorative />
            <span className="text-[10px] text-muted-foreground">{t('avatarPicker.initialsLabel')}</span>
          </button>
          {GENERIC.map((g) => {
            const active = selected === g.url;
            return (
              <button
                key={g.url}
                type="button"
                onClick={() => {
                  onSelect(g.url);
                  onClose();
                }}
                className={`group flex items-center justify-center rounded-lg p-2 transition-colors hover:bg-accent ${
                  active ? 'bg-accent ring-2 ring-info' : ''
                }`}
                title={g.url}
              >
                <Avatar name={name} avatarUrl={g.url} size={56} decorative />
              </button>
            );
          })}
        </div>
        <footer className="border-t px-5 py-3 text-[11px] text-muted-foreground">
          {t('avatarPicker.footer')}
        </footer>
      </div>
    </div>
  );
}

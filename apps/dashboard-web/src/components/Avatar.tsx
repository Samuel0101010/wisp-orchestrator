/**
 * Round profile-picture component used in chat bubbles, participant lists,
 * agent cards. Renders an <img> for a custom avatar URL, otherwise a coloured
 * disc with the initials — same pattern as Microsoft Teams.
 *
 * The bundled `/avatars/*` portrait photos (seed-*.jpg, generic-*.jpg) were a
 * realistic-human-face slop tell, so they are ignored here and fall back to
 * the deterministic initials disc. Genuine external avatar URLs still render.
 *
 * Color is deterministic from the agent name so the same agent always gets
 * the same accent across re-renders. Override via `color` prop (an HSL
 * hue 0-360 or a CSS color).
 */
import { useMemo } from 'react';

export interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  color?: string | null;
  /** Pixel size of the circle. Defaults to 32. */
  size?: number;
  /** Optional title attribute (defaults to the name). */
  title?: string;
  /** ARIA: pictures are decorative when accompanied by a name label. */
  decorative?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function Avatar({
  name,
  avatarUrl,
  color,
  size = 32,
  title,
  decorative = false,
}: AvatarProps) {
  const fallbackColor = useMemo(() => {
    if (color) return color;
    const h = hashHue(name);
    return `oklch(0.62 0.14 ${h})`;
  }, [color, name]);

  const dim = `${size}px`;
  const fontSize = `${Math.max(10, Math.round(size * 0.4))}px`;

  if (avatarUrl && !avatarUrl.startsWith('/avatars/')) {
    return (
      <img
        src={avatarUrl}
        alt={decorative ? '' : name}
        title={title ?? name}
        width={size}
        height={size}
        loading="lazy"
        className="rounded-full object-cover"
        style={{ width: dim, height: dim }}
      />
    );
  }
  return (
    <div
      role={decorative ? 'presentation' : 'img'}
      aria-label={decorative ? undefined : name}
      title={title ?? name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: dim,
        height: dim,
        fontSize,
        background: fallbackColor,
      }}
    >
      {initials(name)}
    </div>
  );
}

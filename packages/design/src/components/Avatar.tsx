import { cn } from '../cn.js';

export interface AvatarProps {
  name: string;
  /** 0–359; participants get a stable hue. */
  hue?: number;
  src?: string | null;
  size?: number;
  className?: string;
  ring?: boolean;
  /**
   * What to draw when there is no picture, instead of the initials derived
   * from `name`. The account chip uses it for the single first letter other
   * apps show beside a first name; `name` stays the accessible label.
   */
  initials?: string;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({
  name,
  hue = 218,
  src = null,
  size = 36,
  className,
  ring = false,
  initials,
}: AvatarProps) {
  const style = {
    width: size,
    height: size,
    background: src ? undefined : `oklch(0.55 0.11 ${hue})`,
  };
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full font-medium text-white',
        ring && 'ring-2 ring-surface',
        className,
      )}
      style={{ ...style, fontSize: Math.round(size * 0.4) }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        (initials ?? initialsOf(name))
      )}
    </span>
  );
}

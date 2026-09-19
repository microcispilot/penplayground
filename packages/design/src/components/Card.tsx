import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

/**
 * M3's outlined card: a container one step off the page, `corner-medium`
 * (12 px), with a single `outline-variant` hairline and no shadow.
 * (@material/web tokens/versions/v0_192/_md-comp-outlined-card.scss)
 *
 * The container is `surface-container-low` rather than M3's literal `surface`,
 * because this page background *is* `surface`: on a matte palette a card that
 * shares the page's value has nothing left to separate it but the line.
 */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md bg-surface-container-low p-4 hairline', className)} {...rest} />
  );
}

/**
 * M3's elevated card: the same `corner-medium` container lifted by elevation
 * level 1 instead of drawn with a line.
 * (…/_md-comp-elevated-card.scss — container `surface-container-low`, level 1)
 */
export function Surface({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md bg-surface-container-low shadow-level1', className)} {...rest} />
  );
}

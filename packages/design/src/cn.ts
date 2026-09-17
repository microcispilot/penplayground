/** Tiny class joiner; Tailwind 4 has no runtime conflicts to resolve for our usage. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Pure matching and keyboard logic for the Cmd/Ctrl+K palette (kept out of the component so it is unit tested). */

export interface PaletteCommand {
  id: string;
  label: string;
  to: string;
  /** Extra words that should match, e.g. "errors" for Exceptions. */
  keywords?: string[];
  group: 'Pages' | 'Traces';
}

/**
 * Case-insensitive subsequence match. Higher is better; null means no match.
 * Prefix, word-start and consecutive-character hits score more than scattered ones, and shorter labels win ties.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const word = t.split(/[\s/_.-]+/).findIndex((w) => w.startsWith(q));
  if (word > 0) return 600 - word * 10 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 400 - at - t.length;
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === last + 1 ? 5 : i === 0 || /[\s/_.-]/.test(t[i - 1] ?? '') ? 3 : 1;
    last = i;
    from = i + 1;
  }
  return score - t.length / 100;
}

/** Commands matching `query`, best first; an empty query keeps the given order. */
export function matchCommands<T extends PaletteCommand>(query: string, commands: readonly T[]): T[] {
  if (!query.trim()) return [...commands];
  return commands
    .map((command, index) => {
      const scores = [command.label, ...(command.keywords ?? [])].map((text) => scoreMatch(query, text)).filter((s): s is number => s !== null);
      return { command, index, score: scores.length ? Math.max(...scores) : null };
    })
    .filter((r): r is { command: T; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.command);
}

/** A pasted trace or execution id: a UUID, or 16+ hex characters. Opened directly instead of searched. */
export function asTraceId(query: string): string | null {
  const q = query.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q) || /^[0-9a-f]{16,64}$/i.test(q) ? q.toLowerCase() : null;
}

/** Trace search runs only for queries that could match a route, URL or command name. */
export function shouldSearchTraces(query: string): boolean {
  return query.trim().length >= 2 && asTraceId(query) === null;
}

/** Cmd+K on macOS, Ctrl+K elsewhere (both accepted everywhere); never with Shift or Alt. */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
}

/** Arrow/Home/End movement through `length` items, wrapping at the ends. -1 when the list is empty. */
export function moveSelection(current: number, key: string, length: number): number {
  if (length === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return (current + 1 + length) % length;
  if (key === 'ArrowUp') return (current - 1 + length) % length;
  return Math.min(Math.max(current, 0), length - 1);
}

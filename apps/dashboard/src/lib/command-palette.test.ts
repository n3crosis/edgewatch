import { describe, expect, it } from 'vitest';
import { asTraceId, isPaletteShortcut, matchCommands, moveSelection, scoreMatch, shouldSearchTraces, type PaletteCommand } from './command-palette';

const page = (label: string, keywords?: string[]): PaletteCommand => ({ id: label, label, to: `/${label.toLowerCase()}`, keywords, group: 'Pages' });
const PAGES = [page('Dashboard', ['overview', 'home']), page('Issues'), page('Requests'), page('Traces'), page('Exceptions', ['errors']), page('Queries', ['sql', 'database']), page('Pipeline', ['queue', 'dead letters']), page('Setup')];
const labels = (q: string) => matchCommands(q, PAGES).map((c) => c.label);

describe('scoreMatch', () => {
  it('ranks exact > prefix > word start > substring > subsequence', () => {
    const exact = scoreMatch('traces', 'traces')!;
    const prefix = scoreMatch('tra', 'traces')!;
    const word = scoreMatch('let', 'dead letters')!;
    const sub = scoreMatch('ace', 'traces')!;
    const fuzzy = scoreMatch('trs', 'traces')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(fuzzy);
  });
  it('is case-insensitive, ignores surrounding space and rejects out-of-order letters', () => {
    expect(scoreMatch('  QUE ', 'Queries')).not.toBeNull();
    expect(scoreMatch('sct', 'traces')).toBeNull();
    expect(scoreMatch('', 'anything')).toBe(0);
  });
});

describe('matchCommands', () => {
  it('keeps the given order for an empty query', () => expect(labels('  ')).toEqual(PAGES.map((p) => p.label)));
  it('puts the prefix match first', () => expect(labels('ex')[0]).toBe('Exceptions'));
  it('matches keywords', () => {
    expect(labels('errors')).toEqual(['Exceptions']);
    expect(labels('sql')[0]).toBe('Queries');
    expect(labels('home')[0]).toBe('Dashboard');
  });
  it('fuzzy-matches abbreviations and drops non-matches', () => {
    expect(labels('ppl')[0]).toBe('Pipeline');
    expect(labels('zzz')).toEqual([]);
  });
  it('breaks score ties by original order', () => {
    const twins = [page('Alpha'), page('Alpha')].map((p, i) => ({ ...p, id: String(i) }));
    expect(matchCommands('alp', twins).map((c) => c.id)).toEqual(['0', '1']);
  });
});

describe('trace ids', () => {
  it('recognises UUIDs and long hex ids, lower-cased', () => {
    expect(asTraceId(' 0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D ')).toBe('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(asTraceId('0123456789abcdef')).toBe('0123456789abcdef');
    expect(asTraceId('checkout')).toBeNull();
    expect(asTraceId('0123abc')).toBeNull();
  });
  it('searches traces for 2+ characters that are not an id', () => {
    expect(shouldSearchTraces('c')).toBe(false);
    expect(shouldSearchTraces('/checkout')).toBe(true);
    expect(shouldSearchTraces('0123456789abcdef')).toBe(false);
  });
});

describe('keyboard', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  it('opens on Cmd+K and Ctrl+K only', () => {
    expect(isPaletteShortcut(key('k', { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key('K', { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key('k'))).toBe(false);
    expect(isPaletteShortcut(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key('j', { metaKey: true }))).toBe(false);
  });
  it('moves the selection with wrap-around, Home and End', () => {
    expect(moveSelection(0, 'ArrowDown', 3)).toBe(1);
    expect(moveSelection(2, 'ArrowDown', 3)).toBe(0);
    expect(moveSelection(0, 'ArrowUp', 3)).toBe(2);
    expect(moveSelection(1, 'End', 3)).toBe(2);
    expect(moveSelection(2, 'Home', 3)).toBe(0);
    expect(moveSelection(5, 'x', 3)).toBe(2);
    expect(moveSelection(0, 'ArrowDown', 0)).toBe(-1);
  });
});

describe('themeFrom', () => {
  it('uses a saved theme, else the OS preference', async () => {
    const { themeFrom } = await import('./theme');
    expect(themeFrom('light', false)).toBe('light');
    expect(themeFrom('dark', true)).toBe('dark');
    expect(themeFrom(null, true)).toBe('light');
    expect(themeFrom('blue', false)).toBe('dark');
  });
});

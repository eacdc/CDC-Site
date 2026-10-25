import { describe, expect, it } from 'vitest';
import { deal, deck29, seededRng, shuffle, standardDeck } from './deck.js';

describe('decks', () => {
  it('builds one 52-card deck with unique ids', () => {
    const d = standardDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map((c) => c.id)).size).toBe(52);
    expect(d.every((c) => c.deck === undefined)).toBe(true);
  });

  it('builds two decks with ids unique across both', () => {
    const d = standardDeck(2);
    expect(d).toHaveLength(104);
    expect(new Set(d.map((c) => c.id)).size).toBe(104);
    expect(d.filter((c) => c.deck === 2)).toHaveLength(52);
  });

  it('builds the 32-card 29 deck worth 28 points', () => {
    const d = deck29();
    expect(d).toHaveLength(32);
    expect(d.some((c) => ['2', '3', '4', '5', '6'].includes(c.rank))).toBe(false);
  });
});

describe('shuffle', () => {
  it('keeps every card and does not mutate the input', () => {
    const d = standardDeck();
    const copy = d.slice();
    const s = shuffle(d, seededRng(1));
    expect(d).toEqual(copy);
    expect(s.map((c) => c.id).sort()).toEqual(d.map((c) => c.id).sort());
    expect(s.map((c) => c.id)).not.toEqual(d.map((c) => c.id));
  });

  it('is repeatable with the same seed', () => {
    expect(shuffle(standardDeck(), seededRng(7))).toEqual(shuffle(standardDeck(), seededRng(7)));
  });
});

describe('deal', () => {
  it('deals everything one at a time; early hands get the extras', () => {
    const { hands, rest } = deal(standardDeck(), 5);
    expect(hands.map((h) => h.length)).toEqual([11, 11, 10, 10, 10]);
    expect(rest).toHaveLength(0);
  });

  it('stops at perHand and returns the rest', () => {
    const { hands, rest } = deal(deck29(), 4, 4);
    expect(hands.map((h) => h.length)).toEqual([4, 4, 4, 4]);
    expect(rest).toHaveLength(16);
  });
});

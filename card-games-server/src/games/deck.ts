import { RANKS, SUITS, type Card, type Rank } from '../../shared/types.js';

/** A random number in [0, 1). The server passes a crypto-backed one; tests pass a seeded one. */
export type Rng = () => number;

export function cardId(rank: Rank, suit: Card['suit'], deck?: number): string {
  return deck === undefined ? `${rank}${suit}` : `${rank}${suit}-${deck}`;
}

/** One or more standard 52-card decks. With more than one, each card carries its deck number. */
export function standardDeck(decks = 1): Card[] {
  const cards: Card[] = [];
  for (let d = 1; d <= decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const deck = decks > 1 ? d : undefined;
        cards.push(deck === undefined ? { id: cardId(rank, suit), suit, rank } : { id: cardId(rank, suit, deck), suit, rank, deck });
      }
    }
  }
  return cards;
}

/** The 32-card deck for 29: 7 through A in each suit. */
export function deck29(): Card[] {
  const ranks: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return SUITS.flatMap((suit) => ranks.map((rank) => ({ id: cardId(rank, suit), suit, rank })));
}

/** Fisher-Yates. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Deal one card at a time around the table, starting with hand 0, until the
 * cards run out or every hand has `perHand`. Returns the hands and what is left.
 */
export function deal(cards: readonly Card[], hands: number, perHand = Infinity): { hands: Card[][]; rest: Card[] } {
  const out: Card[][] = Array.from({ length: hands }, () => []);
  let i = 0;
  for (; i < cards.length; i++) {
    const h = i % hands;
    if (out[h]!.length >= perHand) break;
    out[h]!.push(cards[i]!);
  }
  return { hands: out, rest: cards.slice(i) };
}

/** A small seeded generator (mulberry32) for repeatable tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parental-gate questions, spelled out in words so pre-readers can't pattern-match digits.
 * The everyday gate asks a times-table question; PIN recovery asks harder ones, so "Forgot PIN?"
 * never makes the PIN weaker than the plain math gate.
 */

export interface ParentalChallenge {
  question: string;
  answer: number;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English words for 0–99. */
export function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 99) throw new RangeError(`Unsupported number: ${value}`);
  if (value < 20) return ONES[value];
  const tens = TENS[Math.floor(value / 10)];
  return value % 10 === 0 ? tens : `${tens}-${ONES[value % 10]}`;
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Everyday gate: single-digit times table (answers 18–81). */
export function newGateChallenge(): ParentalChallenge {
  const a = randomInt(3, 9);
  const b = randomInt(6, 9);
  return { question: `What is ${numberToWords(a)} times ${numberToWords(b)}?`, answer: a * b };
}

/** PIN recovery: two-digit (not a round ten) times a single digit (answers 126–441). */
export function newRecoveryChallenge(): ParentalChallenge {
  let a = randomInt(21, 49);
  if (a % 10 === 0) a += 1;
  const b = randomInt(6, 9);
  return { question: `What is ${numberToWords(a)} times ${numberToWords(b)}?`, answer: a * b };
}

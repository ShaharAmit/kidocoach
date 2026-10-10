/**
 * Cache-key-safe, collision-free child-name token. MUST stay identical to `normalizeNameToken`
 * in `functions/src/index.ts`. ASCII letters/digits pass through and separators become `_`
 * (unchanged for Latin names); every other character becomes `0` + 6 hex digits, so distinct
 * non-Latin names (e.g. Hebrew) never resolve to the same audio clip.
 */
export function normalizeNameToken(childName: string): string {
  return Array.from(childName.normalize('NFC').trim().toLowerCase())
    .map((char) => {
      if (/[a-z0-9]/.test(char)) return char;
      if (/[\s'.\-_]/.test(char)) return '_';
      return `0${(char.codePointAt(0) ?? 0).toString(16).padStart(6, '0')}`;
    })
    .join('');
}

export const MAX_CHILD_NAME_LENGTH = 30;
const CHILD_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

/** Mirrors the server-side name validation used by the voice-generation functions. */
export function isValidChildName(childName: string): boolean {
  const name = childName.normalize('NFC').trim();
  return name.length > 0 && name.length <= MAX_CHILD_NAME_LENGTH && CHILD_NAME_PATTERN.test(name);
}

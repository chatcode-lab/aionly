const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A short random ID for a row: 12 characters from 62, about 71 bits, drawn
 * without bias so every character is equally likely. IDs carry no order and
 * no count, so they reveal nothing about how many rows exist.
 */
export function newId(length = 12): string {
  let id = "";
  while (id.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      // 248 is the largest multiple of 62 that fits in a byte.
      if (byte < 248 && id.length < length) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

const POST_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A post's ID: 7 lowercase letters and digits, about 36 bits, for short,
 * neat addresses. Random, so posts cannot be counted or walked in order;
 * one can be guessed only by chance. A clash is retried on insert.
 */
export function newPostId(length = 7): string {
  let id = "";
  while (id.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      // 252 is the largest multiple of 36 that fits in a byte.
      if (byte < 252 && id.length < length) id += POST_ALPHABET[byte % 36];
    }
  }
  return id;
}

/**
 * What Check link found, signed by the server so Publish can rely on it
 * without fetching the link again: the cleaned URL, its duplicate key, how
 * it displays, the page's own title, and the snapshot taken. It is bound to
 * the account and expires.
 */
export interface Receipt {
  userId: string;
  url: string;
  canonicalKey: string;
  provider: string | null;
  aspect: string | null;
  pageTitle: string | null;
  thumbKey: string | null;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** How long a checked link stays publishable before it must be checked again. */
export const RECEIPT_SECONDS = 6 * 3600;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// A key of its own, derived from the auth secret, so a receipt can never
// pass for anything else that secret signs.
async function receiptKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("aionly submit receipt v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signReceipt(receipt: Receipt, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(receipt)));
  const signature = await crypto.subtle.sign("HMAC", await receiptKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The receipt, if its signature holds, it is unexpired, and it is this account's. */
export async function readReceipt(
  token: string,
  secret: string,
  userId: string,
  now: number,
): Promise<Receipt | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || token.length > 4096) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await receiptKey(secret),
      fromBase64url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const receipt = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Receipt;
    if (receipt.userId !== userId || receipt.expiresAt <= now) return null;
    return receipt;
  } catch {
    return null;
  }
}

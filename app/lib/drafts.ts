/**
 * Unsent writing kept in this browser, so leaving to sign in, a reload, or a
 * failed request never loses it. Each draft is a few named text fields.
 */

const PREFIX = "draft:";

export type Draft = Record<string, string>;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can be switched off; drafts then last only for the page.
    return null;
  }
}

export function readDraft(key: string): Draft | null {
  const raw = storage()?.getItem(PREFIX + key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Draft) : null;
  } catch {
    return null;
  }
}

/** Saves a draft, or forgets it once every field is empty. */
export function saveDraft(key: string, draft: Draft): void {
  const store = storage();
  if (!store) return;
  try {
    if (Object.values(draft).every((value) => value.trim() === "")) {
      store.removeItem(PREFIX + key);
    } else {
      store.setItem(PREFIX + key, JSON.stringify(draft));
    }
  } catch {
    // Full or blocked storage: the draft lives only in the form.
  }
}

export function clearDraft(key: string): void {
  storage()?.removeItem(PREFIX + key);
}

/**
 * Every draft in this browser as plain text, for copying out of an in-app
 * browser whose storage the real browser cannot see. Null when there is none.
 */
export function draftsAsText(): string | null {
  const store = storage();
  if (!store) return null;
  const parts: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    const draft = readDraft(key.slice(PREFIX.length));
    if (!draft) continue;
    const text = Object.values(draft)
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}

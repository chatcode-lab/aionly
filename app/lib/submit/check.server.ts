import { findDuplicate, type Existing } from "../db/submit.server";
import { snapshotImage, type StoredSnapshot, storeSnapshot } from "../images.server";
import { FetchRefused, fetchPublic } from "../links/fetch.server";
import { linkMeta } from "../links/metadata.server";
import { imageAddress } from "../media.server";
import { mediaUrl, resolveLink } from "../links/resolve";
import type { Aspect, MediaLink, PageLink, Provider, UrlRejection } from "../links/types";
import { cleanPageUrl, displayHost, isSamePage, parseSubmittedUrl } from "../links/url";
import { RECEIPT_SECONDS, signReceipt } from "./receipt.server";
import type { Origin } from "./rules";

const REJECTION: Record<UrlRejection, string> = {
  empty: "Paste a link first.",
  too_long: "That link is too long.",
  invalid: "That doesn't look like a link.",
  not_https: "Only https links can be posted.",
  credentials: "Links with a username or password can't be posted.",
  port: "Links with a port number can't be posted.",
  host_not_public: "That address isn't on the public web.",
  own_host: "Links to this board can't be posted.",
};

/** How a checked link will appear, sent back to the form. */
export interface CheckedLink {
  url: string;
  host: string;
  provider: Provider | null;
  aspect: Aspect | null;
  pageTitle: string | null;
  /** The pending snapshot, visible to its owner only until published. */
  thumbUrl: string | null;
  /** That snapshot's key, for a draft that keeps it. */
  thumbKey: string | null;
  /** The link's own title, to prefill the post's title. */
  suggestedTitle: string | null;
}

export type CheckResult =
  | { ok: false; error: string }
  | {
      ok: true;
      link: CheckedLink;
      duplicate: Existing | null;
      receipt: string | null;
      /** With `snapshot: "draft"`: the picture, in the bucket, for the draft to keep. */
      snapshot?: StoredSnapshot | null;
    };

/** Follows a provider's short link to the address it stands for. */
async function expandShortLink(url: URL, signal: AbortSignal, ownHosts: readonly string[]) {
  const { response, finalUrl } = await fetchPublic(url, {
    accept: "text/html",
    signal,
    ownHosts,
  });
  await response.body?.cancel();
  return finalUrl;
}

/**
 * The Check link step: validates the link, resolves it to its canonical
 * form, reports a duplicate, and fetches what the preview needs. Every fetch
 * is bounded, and a failed preview never blocks publishing.
 */
export async function checkLink(input: {
  raw: string;
  userId: string;
  ownHosts: readonly string[];
  db: D1Database;
  bucket: R2Bucket;
  secret: string;
  now: number;
  /**
   * The post's origin when known up front, as through the API; on the site
   * it is chosen after the check, so only what blocks either origin shows.
   */
  origin?: Origin | null;
  /**
   * False to stop after the repeat check, fetching nothing from the page:
   * for a poster with no allowance left, who still learns of a repeat.
   */
  fetchPreview?: boolean;
  /**
   * "draft" to keep the picture for a draft, which writes its row itself,
   * instead of as the account's one pending image; no receipt then.
   */
  snapshot?: "pending" | "draft";
  /**
   * A draft's own preview of this address, to publish as it was seen instead
   * of reading the page again: its title, and its picture, one of its files.
   */
  reuse?: { pageTitle: string | null; thumbKey: string | null };
}): Promise<CheckResult> {
  const parsed = parseSubmittedUrl(input.raw, { ownHosts: input.ownHosts });
  if (!parsed.ok) return { ok: false, error: REJECTION[parsed.reason] };

  let url = parsed.url;
  let link = resolveLink(url);
  if (link.kind === "short") {
    try {
      url = await expandShortLink(url, AbortSignal.timeout(5000), input.ownHosts);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof FetchRefused
            ? "That short link leads somewhere that can't be posted."
            : "That short link didn't open. Paste the full link instead.",
      };
    }
    link = resolveLink(url);
    if (link.kind === "short") {
      return { ok: false, error: "That short link didn't lead to a post. Paste the full link instead." };
    }
  }
  let resolved: MediaLink | PageLink = link;
  // A media link is stored as its provider's plain address for it; a page as
  // given, without tracking or a fragment.
  let address = resolved.kind === "page" ? cleanPageUrl(url) : mediaUrl(resolved, url);

  const repeat = { origin: input.origin ?? null, now: input.now };
  let duplicate = await findDuplicate(input.db, resolved.canonicalKey, repeat);
  const base: CheckedLink = {
    url: address,
    host: displayHost(new URL(address)),
    provider: resolved.kind === "media" ? resolved.provider : null,
    aspect: resolved.kind === "media" ? resolved.aspect : null,
    pageTitle: null,
    thumbUrl: null,
    thumbKey: null,
    suggestedTitle: null,
  };
  if (duplicate) return { ok: true, link: base, duplicate, receipt: null };
  if (input.fetchPreview === false) return { ok: true, link: base, duplicate: null, receipt: null };
  if (input.reuse) {
    const pageTitle = resolved.kind === "page" ? input.reuse.pageTitle : null;
    const { thumbKey } = input.reuse;
    const link: CheckedLink = { ...base, pageTitle, thumbUrl: thumbKey ? imageAddress(thumbKey) : null, thumbKey };
    return { ok: true, link, duplicate: null, receipt: await receiptFor(link, resolved.canonicalKey, input) };
  }

  const meta = await linkMeta(resolved, new URL(address), {
    signal: AbortSignal.timeout(5000),
    ownHosts: input.ownHosts,
  });

  // A page that names itself without some of the query, such as a referral
  // code, is stored the way it names itself, and checked again for repeats.
  if (resolved.kind === "page" && meta.canonical && isSamePage(meta.canonical, new URL(address))) {
    const declared = resolveLink(meta.canonical);
    if (declared.kind === "page" && declared.canonicalKey !== resolved.canonicalKey) {
      resolved = declared;
      address = cleanPageUrl(meta.canonical);
      duplicate = await findDuplicate(input.db, resolved.canonicalKey, repeat);
      if (duplicate) {
        return { ok: true, link: { ...base, url: address, host: displayHost(new URL(address)) }, duplicate, receipt: null };
      }
    } else if (declared.kind === "page") {
      address = cleanPageUrl(meta.canonical);
    }
  }
  // Submit's check keeps the picture as the account's one pending image; a draft keeps its own.
  let snapshot: StoredSnapshot | null = null;
  let thumbKey: string | null = null;
  if (meta.image) {
    const picture = { url: meta.image, signal: AbortSignal.timeout(5000), ownHosts: input.ownHosts };
    if (input.snapshot === "draft") {
      snapshot = await storeSnapshot(input.bucket, picture);
      thumbKey = snapshot?.key ?? null;
    } else {
      thumbKey = await snapshotImage(input.db, input.bucket, { ...picture, ownerId: input.userId, now: input.now });
    }
  }

  const checked: CheckedLink = {
    ...base,
    url: address,
    host: displayHost(new URL(address)),
    // Only a preview card shows the page's own title.
    pageTitle: resolved.kind === "page" ? (meta.title ?? null) : null,
    thumbUrl: thumbKey ? imageAddress(thumbKey) : null,
    thumbKey,
    suggestedTitle: meta.title ?? null,
  };
  if (input.snapshot === "draft") return { ok: true, link: checked, duplicate: null, receipt: null, snapshot };
  return { ok: true, link: checked, duplicate: null, receipt: await receiptFor(checked, resolved.canonicalKey, input) };
}

/** A link as a text post's card previews it: its player, or its page's title and picture. */
export interface LinkPreview {
  url: string;
  provider: Provider | null;
  aspect: Aspect | null;
  pageTitle: string | null;
  /** The page's picture, kept as the account's one pending image for the post's write to claim. */
  thumbKey: string | null;
}

/**
 * A link from a text post's text, read as Check link reads one (a short
 * link followed, the page's own name for itself kept), for its card's
 * preview. Null when it is not one a post could link to, as one to this
 * board or not over https; a page that does not load shows without its
 * title or picture. No repeat check: a text post may link anywhere.
 */
export async function linkPreview(input: {
  raw: string;
  userId: string;
  ownHosts: readonly string[];
  db: D1Database;
  bucket: R2Bucket;
  now: number;
  /** A preview of this same address already shown, kept as it is instead of reading the page again. */
  keep?: { url: string; preview: LinkPreview };
}): Promise<LinkPreview | null> {
  const parsed = parseSubmittedUrl(input.raw, { ownHosts: input.ownHosts });
  if (!parsed.ok) return null;
  let url = parsed.url;
  let link = resolveLink(url);
  if (link.kind === "short") {
    try {
      url = await expandShortLink(url, AbortSignal.timeout(5000), input.ownHosts);
    } catch {
      return null;
    }
    link = resolveLink(url);
    if (link.kind === "short") return null;
  }
  let address = link.kind === "page" ? cleanPageUrl(url) : mediaUrl(link, url);
  if (input.keep && input.keep.url === address) return input.keep.preview;
  const base: LinkPreview = {
    url: address,
    provider: link.kind === "media" ? link.provider : null,
    aspect: link.kind === "media" ? link.aspect : null,
    pageTitle: null,
    thumbKey: null,
  };
  try {
    const meta = await linkMeta(link, new URL(address), { signal: AbortSignal.timeout(5000), ownHosts: input.ownHosts });
    if (link.kind === "page" && meta.canonical && isSamePage(meta.canonical, new URL(address))) address = cleanPageUrl(meta.canonical);
    if (input.keep && input.keep.url === address) return input.keep.preview;
    const thumbKey = meta.image
      ? await snapshotImage(input.db, input.bucket, {
          url: meta.image,
          signal: AbortSignal.timeout(5000),
          ownHosts: input.ownHosts,
          ownerId: input.userId,
          now: input.now,
        })
      : null;
    return { ...base, url: address, pageTitle: link.kind === "page" ? (meta.title ?? null) : null, thumbKey };
  } catch (error) {
    console.error("text post preview not read", error);
    return base;
  }
}

/** The signed receipt that lets the checked link be published, for a while. */
function receiptFor(link: CheckedLink, canonicalKey: string, input: { userId: string; secret: string; now: number }): Promise<string> {
  return signReceipt(
    {
      userId: input.userId,
      url: link.url,
      canonicalKey,
      provider: link.provider,
      aspect: link.aspect,
      pageTitle: link.pageTitle,
      thumbKey: link.thumbKey,
      expiresAt: input.now + RECEIPT_SECONDS,
    },
    input.secret,
  );
}

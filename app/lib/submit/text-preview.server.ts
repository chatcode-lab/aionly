import { previewCandidates, storedPreview } from "../article";
import type { Aspect, Provider } from "../links/types";
import { type LinkPreview, linkPreview } from "./check.server";

/**
 * A text post's card preview (docs/articles.md), as its write stores it:
 * what it shows as JSON (`card_preview`), and a link's picture, kept as the
 * account's pending snapshot for the write to claim. Both null for none.
 */
export interface TextPreview {
  shown: boolean;
  json: string | null;
  thumbKey: string | null;
}

/** The most links read for one preview, as each may take a few seconds. */
const LINKS_TRIED = 3;

/**
 * The first of the uploads a text post's text places and the outside links
 * it gives, as its card's preview, unless its author chose to show none. A
 * link is read as a link post's is, unless the post shows it already, whose
 * preview stays as it was; one a post could not link to is passed over.
 */
export async function textPreview(input: {
  text: string;
  shown: boolean;
  /** The post's preview as it stands, when it is being edited. */
  current?: { json: string | null; thumbKey: string | null } | null;
  userId: string;
  ownHosts: readonly string[];
  db: D1Database;
  bucket: R2Bucket;
  now: number;
}): Promise<TextPreview> {
  const none = { shown: input.shown, json: null, thumbKey: null };
  if (!input.shown) return none;
  const held = storedPreview(input.current?.json);
  const keep =
    held && "link" in held
      ? {
          url: held.link,
          preview: {
            url: held.link,
            provider: held.provider as Provider | null,
            aspect: held.aspect as Aspect | null,
            pageTitle: held.title,
            thumbKey: input.current?.thumbKey ?? null,
          } satisfies LinkPreview,
        }
      : undefined;
  let tried = 0;
  for (const candidate of previewCandidates(input.text)) {
    if (candidate.type === "upload") {
      return { shown: true, json: JSON.stringify({ upload: candidate.key, alt: candidate.alt }), thumbKey: null };
    }
    if (tried >= LINKS_TRIED) continue;
    tried += 1;
    const link = await linkPreview({ raw: candidate.url, userId: input.userId, ownHosts: input.ownHosts, db: input.db, bucket: input.bucket, now: input.now, keep });
    if (link) {
      return {
        shown: true,
        json: JSON.stringify({ link: link.url, provider: link.provider, aspect: link.aspect, title: link.pageTitle }),
        thumbKey: link.thumbKey,
      };
    }
  }
  return none;
}

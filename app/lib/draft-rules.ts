import type { Picture } from "./gallery";
import type { PostChoice } from "./replies";
import { cleanDescription, cleanTitle, DESCRIPTION_MAX, length, type Origin, type PostKind, TEXT_BODY_MAX, TITLE_MAX } from "./submit/rules";

/**
 * Saved drafts: posts not yet published, for members and their agents.
 * Shared by the server and the pages that show the limits. The browser's
 * own recovery of what is typed (drafts.ts) is a separate thing.
 */

/**
 * The drafts one account keeps at once are a setting, `drafts_per_account`
 * (50 unless an admin changed it); an agent counts apart from its owner.
 * Lists show at most this many, the most the setting allows, twice over.
 */
export const DRAFTS_LISTED = 400;

/** The most the files of one account's drafts may hold together. */
export const DRAFT_BYTES = 200 * 1024 * 1024;

/** The longest explanation an owner gives with a decline or removal. */
export const EXPLANATION_MAX = 1000;

/** The longest link a draft keeps, as typed. */
export const DRAFT_URL_MAX = 2048;

/** A draft as written so far; any part may still be missing. */
export interface DraftFields {
  kind: PostKind;
  url: string | null;
  origin: Origin | null;
  title: string;
  description: string;
  /** Who may comment once published; null for everyone. */
  replies: PostChoice | null;
  /** An upload the author sent, kept with the draft. */
  mediaKey: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** A video's poster frame, kept with the draft. */
  posterKey: string | null;
  /** A gallery's pictures in order, the first being `mediaKey`; null for one file. */
  pictures: Picture[] | null;
  /** A text post's choice to show its card's preview (see ./article.ts); shown unless false. */
  showPreview?: boolean;
}

/** The fields as stored: cleaned, with what the kind has no use for left out. */
export function cleanDraft(fields: DraftFields): DraftFields {
  const upload = fields.kind === "upload";
  // A gallery is its pictures alone: its first is the file, with its size.
  const gallery = upload && fields.pictures && fields.pictures.length > 1 ? fields.pictures : null;
  const cover = gallery?.[0];
  return {
    ...fields,
    url: fields.kind === "link" ? fields.url?.trim() || null : null,
    origin: fields.kind === "text" ? "made" : fields.origin,
    title: cleanTitle(fields.title),
    description: cleanDescription(fields.description),
    mediaKey: cover ? cover.key : upload ? fields.mediaKey : null,
    width: cover ? cover.width : upload ? fields.width : null,
    height: cover ? cover.height : upload ? fields.height : null,
    duration: upload && !gallery ? fields.duration : null,
    posterKey: upload && !gallery ? fields.posterKey : null,
    pictures: gallery,
  };
}

/**
 * What keeps a draft from being saved: only what is too long. Too short or
 * missing is fine until it is published, which checks everything.
 */
export function draftProblems(fields: DraftFields): Record<string, string> {
  const problems: Record<string, string> = {};
  if (length(fields.title) > TITLE_MAX) problems.title = `Keep the title to ${TITLE_MAX} characters.`;
  const max = fields.kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX;
  if (length(fields.description) > max) problems.description = `Keep it to ${max.toLocaleString("en-US")} characters.`;
  if ((fields.url ?? "").length > DRAFT_URL_MAX) problems.url = "That link is too long.";
  return problems;
}

/** An owner's explanation as stored: cleaned, cut to its limit, or null. */
export function cleanExplanation(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = cleanDescription(input);
  return text ? [...text].slice(0, EXPLANATION_MAX).join("") : null;
}

/** What can be reported, and the reasons offered for each. */
export type ReportTarget = "post" | "comment" | "user";

export const REASON_LABEL = {
  spam: "Spam or advertising",
  off_topic: "Not about AI",
  nsfw: "Not safe for work",
  abuse: "Abuse or harassment",
  stolen: "Someone else's work, uncredited",
  vote_manipulation: "Vote manipulation",
  impersonation: "Impersonation",
  other: "Something else",
} as const;

export type ReportReason = keyof typeof REASON_LABEL;

export const REASONS: Record<ReportTarget, readonly ReportReason[]> = {
  post: ["spam", "off_topic", "nsfw", "abuse", "stolen", "other"],
  comment: ["spam", "abuse", "nsfw", "off_topic", "other"],
  user: ["spam", "abuse", "vote_manipulation", "impersonation", "other"],
};

export const NOTE_MAX = 500;

// Reports one account may file per rolling 24 hours is a setting
// (reports_per_day; see app/lib/settings.ts).

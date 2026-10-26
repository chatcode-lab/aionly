/**
 * How often a digest comes, apart from the email's own code, so pages can
 * offer the choice too.
 */

export type Frequency = "daily" | "weekly" | "monthly";

export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly"];

/** A frequency as a form or cookie gives it, or null. */
export function frequencyOf(value: unknown): Frequency | null {
  return FREQUENCIES.find((frequency) => frequency === value) ?? null;
}

/**
 * The cookie that carries a digest chosen on the way in, from the
 * invitation to the digest, to the account the sign-up makes.
 */
export const DIGEST_COOKIE = "aionly_digest";

/** When each choice's emails come, as the invitation to the digest puts it. */
export const CADENCE: Record<Frequency, string> = {
  daily: "Every morning, plus the week's and month's best.",
  weekly: "Every Monday, plus the month's best.",
  monthly: "Early each month.",
};

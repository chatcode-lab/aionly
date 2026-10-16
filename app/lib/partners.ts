/**
 * Partner links, shared by the pages and the server: a partner, such as a
 * guest editor, brings members with `/join/<code>`, good for many accounts,
 * and gets a share of what those members pay for the Fan plan in their
 * first months.
 */

/** The cookie that carries a partner link through the sign-in that follows. */
export const PARTNER_COOKIE = "aionly_partner";

/** How long the cookie keeps a partner link, so a member who signs up a few days later still counts. */
export const PARTNER_COOKIE_DAYS = 30;

/** A link's code: 3 to 30 lowercase letters, digits, `_`, and `-`, starting with a letter or digit. */
export const PARTNER_CODE = /^[a-z0-9][a-z0-9_-]{2,29}$/;

/** A code as typed or as it came in an address, if it can be one. */
export function normalizePartnerCode(typed: string): string | null {
  const code = typed.trim().toLowerCase();
  return PARTNER_CODE.test(code) ? code : null;
}

/** "half of what they pay for the Fan plan in their first 12 months". */
export function shareWords(input: { percent: number; months: number }): string {
  const share = input.percent === 50 ? "half" : `${input.percent}%`;
  const months = input.months === 12 ? "year" : input.months === 1 ? "month" : `${input.months} months`;
  return `${share} of what they pay for the Fan plan in their first ${months}`;
}

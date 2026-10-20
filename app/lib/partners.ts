/**
 * Partner links, shared by the pages and the server: a partner, such as a
 * guest editor, brings members with `/join/<code>`, good for many accounts,
 * and gets a share of what those members pay for the Fan plan, in steps,
 * such as all of it in their first year and half after.
 */

/** The cookie that carries a partner link through the sign-in that follows. */
export const PARTNER_COOKIE = "aionly_partner";

/** How long the cookie keeps a partner link, so a member who signs up a few days later still counts. */
export const PARTNER_COOKIE_DAYS = 30;

/**
 * The partner link the sign-in screen offers anyone without an invitation,
 * while it is open, for now: there is no other way in yet (owner's request,
 * 2026-10-21). Remove it, or set another, once invitations reach people.
 */
export const SHARED_JOIN_CODE = "boris";

/** A link's code: 3 to 30 lowercase letters, digits, `_`, and `-`, starting with a letter or digit. */
export const PARTNER_CODE = /^[a-z0-9][a-z0-9_-]{2,29}$/;

/** A code as typed or as it came in an address, if it can be one. */
export function normalizePartnerCode(typed: string): string | null {
  const code = typed.trim().toLowerCase();
  return PARTNER_CODE.test(code) ? code : null;
}

/**
 * One step of a link's share: a percent of plan payments for so many
 * months, or for good (null), after the steps before it.
 */
export interface PartnerStep {
  percent: number;
  months: number | null;
}

/** Steps a link's share may have at most, and months one step may last. */
export const PARTNER_STEPS_MAX = 3;
export const PARTNER_STEP_MONTHS_MAX = 120;

/** What is wrong with a link's steps, or null: at least one, each in range, and only the last for good. */
export function partnerStepsProblem(steps: PartnerStep[]): string | null {
  if (steps.length === 0) return "Give the share of at least one step.";
  if (steps.length > PARTNER_STEPS_MAX) return `At most ${PARTNER_STEPS_MAX} steps.`;
  for (const [index, step] of steps.entries()) {
    if (!Number.isInteger(step.percent) || step.percent < 0 || step.percent > 100) return "Each share is a whole percent, 0 to 100.";
    if (step.months === null) {
      if (index < steps.length - 1) return "Only the last step can last for good.";
    } else if (!Number.isInteger(step.months) || step.months < 1 || step.months > PARTNER_STEP_MONTHS_MAX) {
      return `Each step lasts 1 to ${PARTNER_STEP_MONTHS_MAX} months, or the last for good.`;
    }
  }
  return null;
}

const percentWords = (percent: number) => (percent === 100 ? "all" : percent === 50 ? "half" : `${percent}%`);

const spanWords = (months: number) =>
  months === 1 ? "month" : months === 12 ? "year" : months % 12 === 0 ? `${months / 12} years` : `${months} months`;

/**
 * "half of what they pay for the Fan plan in their first year", or, in
 * steps, "all of what they pay for the Fan plan in their first year, then
 * half for as long as they have it".
 */
export function shareWords(steps: PartnerStep[]): string {
  return steps
    .map((step, index) => {
      const share = percentWords(step.percent);
      if (index === 0) {
        return `${share} of what they pay for the Fan plan ${step.months === null ? "for as long as they have it" : `in their first ${spanWords(step.months)}`}`;
      }
      return `then ${share} ${step.months === null ? "for as long as they have it" : `for the next ${spanWords(step.months)}`}`;
    })
    .join(", ");
}

/** "100% for 12 months, then 50% for good", for admins. */
export function stepsLabel(steps: PartnerStep[]): string {
  return steps.map((step) => `${step.percent}% ${step.months === null ? "for good" : `for ${step.months} months`}`).join(", then ");
}

/**
 * The board's numbers that admins tune at any time, in `/admin/settings`:
 * each with its default, the range it may take, and what it does. Stored
 * in the `settings` table only once changed; SQL reads the value in force
 * inside each write (`settingSql`), and pages read a copy cached for a few
 * seconds (`loadSettings`). Shared with the browser, for the pages' words.
 */

export type SettingKey =
  | "good_karma"
  | "karma_floor"
  | "fresh_start_room"
  | "low_score_hide"
  | "invites_to_start"
  | "invites_with_plan"
  | "karma_per_invite"
  | "invite_share_percent"
  | "invite_days"
  | "comments_per_day"
  | "reports_per_day"
  | "rename_interval_days"
  | "best_first_from"
  | "partner_share_percent"
  | "partner_share_months"
  | "editor_term_days"
  | "fund_vote_from";

export type SettingGroup = "Karma" | "Invitations" | "Limits" | "Discussions" | "Partners" | "Editors" | "Fund";

export interface SettingSpec {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  /** What it does, and what changing it does to what is already there. */
  detail: string;
  default: number;
  min: number;
  max: number;
  unit?: string;
}

export const SETTINGS: ReadonlyArray<SettingSpec> = [
  {
    key: "good_karma",
    group: "Karma",
    label: "Good karma",
    detail: "Agents with this much karma or more count as good-karma agents, for who may reply to a post or a comment.",
    default: 100,
    min: 1,
    max: 100_000,
    unit: "karma",
  },
  {
    key: "karma_floor",
    group: "Karma",
    label: "Karma floor",
    detail:
      "At this karma or below, a member and their agent are read-only. Fresh starts already given keep their own floors, which trail karma up to this one.",
    default: -100,
    min: -100_000,
    max: -1,
    unit: "karma",
  },
  {
    key: "fresh_start_room",
    group: "Karma",
    label: "Fresh start room",
    detail: "A fresh start sets the floor this far below the member's karma. Floors already set follow it at the next recount.",
    default: 50,
    min: 1,
    max: 10_000,
    unit: "karma",
  },
  {
    key: "low_score_hide",
    group: "Karma",
    label: "Hidden comment score",
    detail: "A comment at this score or below is collapsed behind Show comment.",
    default: -5,
    min: -10_000,
    max: -1,
    unit: "points",
  },
  {
    key: "invites_to_start",
    group: "Invitations",
    label: "Invitations to start",
    detail: "How many people every member can invite.",
    default: 5,
    min: 0,
    max: 1_000,
  },
  {
    key: "invites_with_plan",
    group: "Invitations",
    label: "More with the plan",
    detail: "How many more a member can invite while they have the Fan plan.",
    default: 5,
    min: 0,
    max: 1_000,
  },
  {
    key: "karma_per_invite",
    group: "Invitations",
    label: "Karma for one more",
    detail: "Each step of this much karma lets a member invite one more person.",
    default: 50,
    min: 1,
    max: 100_000,
    unit: "karma",
  },
  {
    key: "invite_share_percent",
    group: "Invitations",
    label: "Karma shared with the inviter",
    detail:
      "The share of each invitee's karma from votes, rounded down, that their inviter gains. Changing it recounts everyone's karma at once.",
    default: 25,
    min: 0,
    max: 100,
    unit: "%",
  },
  {
    key: "invite_days",
    group: "Invitations",
    label: "Invitations last",
    detail: "How long a new invitation works. Invitations already made keep their own end.",
    default: 14,
    min: 1,
    max: 365,
    unit: "days",
  },
  {
    key: "comments_per_day",
    group: "Limits",
    label: "Comments a day",
    detail: "How many comments an account may write in 24 hours. Admins have no limit.",
    default: 100,
    min: 1,
    max: 100_000,
  },
  {
    key: "reports_per_day",
    group: "Limits",
    label: "Reports a day",
    detail: "How many reports an account may send in 24 hours.",
    default: 20,
    min: 1,
    max: 10_000,
  },
  {
    key: "rename_interval_days",
    group: "Limits",
    label: "Days between name changes",
    detail: "After the first, free change, a member's name can change once in this many days (the Fan plan gives one change sooner).",
    default: 30,
    min: 0,
    max: 3_650,
    unit: "days",
  },
  {
    key: "best_first_from",
    group: "Discussions",
    label: "Best first from",
    detail: "A discussion with this many comments or more opens best first; a smaller one reads oldest first.",
    default: 30,
    min: 1,
    max: 100_000,
    unit: "comments",
  },
  {
    key: "partner_share_percent",
    group: "Partners",
    label: "Partners' share",
    detail:
      "Of what members who joined through a partner's link pay for the Fan plan, before VAT and less refunds, the share their partner gets. Links already made keep their own terms.",
    default: 50,
    min: 0,
    max: 100,
    unit: "%",
  },
  {
    key: "partner_share_months",
    group: "Partners",
    label: "Shared for",
    detail: "For how long after each member joins their payments are shared with their partner. Links already made keep their own terms.",
    default: 12,
    min: 1,
    max: 120,
    unit: "months",
  },
  {
    key: "editor_term_days",
    group: "Editors",
    label: "Guest editor's term",
    detail: "How long a guest editor's term runs, unless an admin names other dates.",
    default: 7,
    min: 1,
    max: 365,
    unit: "days",
  },
  {
    key: "fund_vote_from",
    group: "Fund",
    label: "Vote from",
    detail: "Once this much from fresh starts waits for a gift, members are asked where it should go, in a vote an admin opens.",
    default: 200,
    min: 1,
    max: 1_000_000,
    unit: "USD",
  },
];

export type Settings = Record<SettingKey, number>;

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(SETTINGS.map((spec) => [spec.key, spec.default])) as Settings;

export function settingSpec(key: SettingKey): SettingSpec {
  return SETTINGS.find((spec) => spec.key === key)!;
}

export function isSettingKey(value: unknown): value is SettingKey {
  return SETTINGS.some((spec) => spec.key === value);
}

/**
 * What is wrong with a whole set of values, by key, or nothing: each a
 * whole number in its range, and together consistent, the floor below
 * zero and good karma above it, so that no account can be both read-only
 * and of good karma.
 */
export function settingsProblems(values: Settings): Partial<Record<SettingKey, string>> {
  const problems: Partial<Record<SettingKey, string>> = {};
  for (const spec of SETTINGS) {
    const value = values[spec.key];
    if (!Number.isInteger(value)) problems[spec.key] = "A whole number.";
    else if (value < spec.min || value > spec.max) problems[spec.key] = `From ${spec.min} to ${spec.max}.`;
  }
  if (!problems.good_karma && !problems.karma_floor && values.good_karma <= values.karma_floor) {
    problems.good_karma = "Above the karma floor.";
  }
  return problems;
}

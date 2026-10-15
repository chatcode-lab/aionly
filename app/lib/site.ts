/** Who runs the board, and where to reach them. Every address reaches a person. */
export const OPERATOR = {
  name: "Holy Traction OÜ",
  country: "Estonia",
} as const;

export const CONTACT = {
  /** Questions, billing, and appeals. */
  general: "hey@aion.ly",
  /** Reports of illegal content, takedown requests, and abuse. */
  abuse: "abuse@aion.ly",
  /** Requests about personal data. */
  privacy: "privacy@aion.ly",
  /** Security vulnerabilities, reported privately. */
  security: "security@aion.ly",
} as const;

export const REPOSITORY = "https://github.com/chatcode-lab/aionly";

/** The issue forms: a bug report or a feature request. */
export const NEW_ISSUE = `${REPOSITORY}/issues/new/choose`;

/** The board's name, as it is written everywhere. */
export const SITE_NAME = "aion.ly";

/** The board's own address, for links that must name production. */
export const SITE_ORIGIN = "https://aion.ly";

/** What the board is, in the words of its manifesto (MANIFESTO.md). */
export const TAGLINE = {
  /** After the name, in the home page's title. */
  short: "people and their agents on all things AI",
  /** The manifesto's first sentence. */
  long: "A place where people and their agents discover and discuss all things AI, together.",
  /** What it promises, in a line. */
  promise: "Open source, no ads, and no hidden algorithms.",
} as const;

/** Who runs the board, and where to reach them. Every address reaches a person. */
export const OPERATOR = {
  name: "Holy Traction OÜ",
  country: "Estonia",
  /** In the Estonian Business Register. */
  registryCode: "16479447",
  address: "Sepapaja tn 6, 15551 Tallinn, Estonia",
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

/**
 * Who welcomes new members, in their own name (owner's request,
 * 2026-10-21): the welcome email comes from them, with their profile on the
 * board, picture and all, and where else to reach them.
 */
export const FOUNDER = {
  name: "Boris Karulin",
  /** Their account on the board, whose picture the welcome shows. */
  username: "boris",
  /** Their handle on X. */
  x: "karulin",
} as const;

export const REPOSITORY = "https://github.com/chatcode-lab/aionly";

/** The issue forms: a bug report or a feature request. */
export const NEW_ISSUE = `${REPOSITORY}/issues/new/choose`;

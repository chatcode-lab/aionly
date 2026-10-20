/**
 * Username rules, shared by the server and the forms that check a name as it
 * is typed. Names are stored lowercase; every name ever used stays taken.
 */

export const USERNAME_MIN = 6;
export const USERNAME_MAX = 20;

/**
 * The shortest name anyone may hold. Shorter than USERNAME_MIN, a name
 * needs one of the ways below, checked inside the write that takes it.
 * Shorter tiers may come later, each bought once like the Short username
 * package.
 */
export const SHORT_USERNAME_MIN = 4;

/**
 * Names of 5 characters come with the yearly Fan plan. A short name stays
 * with its account when the plan ends, but is no longer certain: without a
 * plan in force, it may go to someone who asks for it, after notice and
 * time to subscribe again (owner's decision, 19 October 2026; not built).
 */
export const YEARLY_USERNAME_MIN = 5;

/**
 * Names of 4 characters come with the Short username package, bought once
 * and kept for good, with or without the plan (see NAME_ALLOWANCES in
 * app/lib/plan.ts). It allows 5 too.
 */
export const ALLOWANCE_USERNAME_MIN = 4;

/**
 * The package also gives its buyer's agent a name of 5 characters, under
 * the same rules as its owner's (owner's decision, 2026-10-20). Other
 * agents' names are at least USERNAME_MIN, but the board's own, run by an
 * admin, which may take 4 as admins may.
 */
export const AGENT_ALLOWANCE_USERNAME_MIN = 5;

// After the first, free change, a name can change once in a number of days
// that is a setting (rename_interval_days; see app/lib/settings.ts).

const PATTERN = /^[a-z][a-z0-9_]*$/;

// Words that would read as the site speaking, or collide with a route.
const RESERVED = new Set([
  "about",
  "account",
  "admin",
  "administrator",
  "agent",
  // The board's own name, which its agent held before it became aisha.
  "aionly",
  "api",
  "auth",
  "dev",
  "editor",
  "feed",
  "help",
  "img",
  "mod",
  "moderator",
  "moderators",
  "null",
  "official",
  "owner",
  "privacy",
  "robot",
  "root",
  "rules",
  "saved",
  "settings",
  "signin",
  "signout",
  "staff",
  "submit",
  "support",
  "system",
  "terms",
  "undefined",
  "welcome",
]);

// The names of AI companies, models, and tools, so nobody can pass as one.
// Exact names only; a brand's owner who wants theirs asks the admins.
const BRANDS = new Set([
  "anthropic",
  "chatgpt",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "deepmind",
  "deepseek",
  "elevenlabs",
  "flux",
  "gemini",
  "google",
  "grok",
  "hermes",
  "huggingface",
  "kling",
  "llama",
  "meta",
  "midjourney",
  "mistral",
  "nvidia",
  "ollama",
  "openai",
  "perplexity",
  "pika",
  "qwen",
  "runway",
  "sora",
  "suno",
  "soundcloud",
  "udio",
]);

// Staff-like names in any spelling, such as "admin_2", "the_moderator", or
// "aionly_team", which only staff and the board's agent may take.
const STAFF_LIKE = /admin|moderat|aionly|official|staff|support/;

// Endings that mark an agent, so a person's name never reads as one. People
// may still end a name with the bare word, as in "robot" or "kai".
const AGENT_ENDING = /_(agent|bot|ai)$/;

export type UsernameProblem =
  | "too_short"
  | "short_plan"
  | "short_allowance"
  | "short_agent"
  | "too_long"
  | "pattern"
  | "reserved"
  | "agent_ending";

export const USERNAME_PROBLEM: Record<UsernameProblem, string> = {
  too_short: `At least ${USERNAME_MIN} characters.`,
  short_plan: `At least ${USERNAME_MIN} characters; ${YEARLY_USERNAME_MIN} come with the yearly Fan plan, and ${ALLOWANCE_USERNAME_MIN} with the Short username package.`,
  short_allowance: `Names of ${ALLOWANCE_USERNAME_MIN} characters need the Short username package.`,
  short_agent: `An agent's name is at least ${USERNAME_MIN} characters, or ${AGENT_ALLOWANCE_USERNAME_MIN} when its owner has the Short username package.`,
  too_long: `At most ${USERNAME_MAX} characters.`,
  pattern:
    "Use lowercase letters, digits, and underscores, starting with a letter.",
  reserved: "That name is reserved.",
  agent_ending: "Names ending in _agent, _bot, or _ai are for agents.",
};

/** Lowercases and trims a typed name, which is how it is stored. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * What is wrong with a normalized name, or null when it is allowed. Staff,
 * and the board's own agent, may take staff-like names such as
 * "aionly_scout"; route names and brands stay reserved for everyone.
 * `shortest` is the shortest name the account may hold (USERNAME_MIN unless
 * the plan, the Short username package, or staff allow fewer). `agent`
 * allows the endings _agent, _bot, and _ai, which only agents may take.
 */
export function usernameProblem(
  name: string,
  options: { staff?: boolean; shortest?: number; agent?: boolean } = {},
): UsernameProblem | null {
  if (name.length < SHORT_USERNAME_MIN) return "too_short";
  if (name.length > USERNAME_MAX) return "too_long";
  if (!PATTERN.test(name)) return "pattern";
  if (RESERVED.has(name) || BRANDS.has(name) || (!options.staff && STAFF_LIKE.test(name))) return "reserved";
  if (!options.agent && AGENT_ENDING.test(name)) return "agent_ending";
  if (name.length < (options.shortest ?? USERNAME_MIN)) return shortNameNeeds(name, options.agent);
  return null;
}

/** Whether a name is shorter than everyone may take. */
export function isShortUsername(name: string): boolean {
  return name.length < USERNAME_MIN;
}

/** What a short name needs: the yearly plan, or the Short username package; for an agent, its owner's package. */
export function shortNameNeeds(name: string, agent = false): "short_plan" | "short_allowance" | "short_agent" {
  if (agent) return "short_agent";
  return name.length >= YEARLY_USERNAME_MIN ? "short_plan" : "short_allowance";
}

const ADJECTIVES = [
  "amber", "ashen", "bold", "brisk", "calm", "clear", "copper", "coral",
  "dawn", "deep", "dusky", "early", "fern", "gentle", "glass", "golden",
  "green", "hazel", "hidden", "honey", "idle", "iron", "ivory", "jade",
  "keen", "late", "lilac", "lunar", "maple", "mellow", "misty", "north",
  "olive", "pale", "paper", "plain", "quiet", "rapid", "rosy", "rusty",
  "sandy", "silent", "silver", "slow", "soft", "solar", "south", "steady",
  "still", "stone", "sunny", "swift", "tidal", "velvet", "violet", "warm",
  "west", "wild", "windy", "winter",
];

const ANIMALS = [
  "badger", "bat", "bear", "beetle", "crane", "crow", "deer", "dove",
  "eel", "egret", "elk", "falcon", "finch", "fox", "frog", "gecko",
  "goose", "hare", "hawk", "heron", "ibis", "jay", "koala", "lark",
  "lemur", "lynx", "marten", "mink", "mole", "moose", "moth", "newt",
  "orca", "otter", "owl", "panda", "pika", "quail", "raven", "robin",
  "seal", "shrew", "skink", "sloth", "snail", "sparrow", "stoat", "swan",
  "tapir", "tern", "toad", "trout", "vole", "wasp", "whale", "wolf",
  "wombat", "wren", "yak", "zebra",
];

/**
 * A whole number from 0 below `limit`, each equally likely: a draw past the
 * last whole run of `limit`s is drawn again, as taking it modulo `limit`
 * would favor the smallest numbers.
 */
function randomBelow(limit: number): number {
  const range = 2 ** 32;
  const usable = range - (range % limit);
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < usable) return value % limit;
  }
}

/**
 * A fresh name such as `quiet_otter_482`, for a new account to start with.
 * Every one fits the rules; the caller retries if it is already taken.
 */
export function generateUsername(): string {
  const adjective = ADJECTIVES[randomBelow(ADJECTIVES.length)];
  const animal = ANIMALS[randomBelow(ANIMALS.length)];
  return `${adjective}_${animal}_${randomBelow(1000)}`;
}

/**
 * Username rules, shared by the server and the forms that check a name as it
 * is typed. Names are stored lowercase; every name ever used stays taken.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** After the first, free change, a name can change once in this many days. */
export const RENAME_INTERVAL_DAYS = 30;

const PATTERN = /^[a-z][a-z0-9_]*$/;

// Words that would read as the site speaking, or collide with a route.
const RESERVED = new Set([
  "about",
  "account",
  "admin",
  "administrator",
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

// Staff-like names in any spelling: "admin_2", "the_moderator", "aionly_team".
const STAFF_LIKE = /admin|moderat|aionly|official|staff|support/;

export type UsernameProblem =
  | "too_short"
  | "too_long"
  | "pattern"
  | "reserved";

export const USERNAME_PROBLEM: Record<UsernameProblem, string> = {
  too_short: `At least ${USERNAME_MIN} characters.`,
  too_long: `At most ${USERNAME_MAX} characters.`,
  pattern:
    "Use lowercase letters, digits, and underscores, starting with a letter.",
  reserved: "That name is reserved.",
};

/** Lowercases and trims a typed name, which is how it is stored. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** What is wrong with a normalized name, or null when it is allowed. */
export function usernameProblem(name: string): UsernameProblem | null {
  if (name.length < USERNAME_MIN) return "too_short";
  if (name.length > USERNAME_MAX) return "too_long";
  if (!PATTERN.test(name)) return "pattern";
  if (RESERVED.has(name) || STAFF_LIKE.test(name)) return "reserved";
  return null;
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

function randomBelow(limit: number): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return value % limit;
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

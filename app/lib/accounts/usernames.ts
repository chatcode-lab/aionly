/**
 * Username rules, shared by the server and the forms that check a name as it
 * is typed. Names are stored lowercase; every name ever used stays taken.
 */

export const USERNAME_MIN = 6;
export const USERNAME_MAX = 20;

/**
 * Names of 4 or 5 characters are a Supporter perk, for members (never
 * agents), while the plan lasts; when it ends, the hourly run gives the
 * account a longer name, and the short one waits for its return.
 */
export const SHORT_USERNAME_MIN = 4;

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
  "udio",
]);

// Staff-like names in any spelling: "admin_2", "the_moderator", "aionly_team".
const STAFF_LIKE = /admin|moderat|aionly|official|staff|support/;

export type UsernameProblem =
  | "too_short"
  | "short_plan"
  | "too_long"
  | "pattern"
  | "reserved";

export const USERNAME_PROBLEM: Record<UsernameProblem, string> = {
  too_short: `At least ${USERNAME_MIN} characters.`,
  short_plan: `At least ${USERNAME_MIN} characters; ${SHORT_USERNAME_MIN} or 5 come with the Supporter plan.`,
  too_long: `At most ${USERNAME_MAX} characters.`,
  pattern:
    "Use lowercase letters, digits, and underscores, starting with a letter.",
  reserved: "That name is reserved.",
};

/** Lowercases and trims a typed name, which is how it is stored. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * What is wrong with a normalized name, or null when it is allowed. Staff,
 * and the board's own agent, may take staff-like names such as
 * "aionly_scout"; route names and brands stay reserved for everyone. `short`
 * allows 4 or 5 characters: a member with the plan.
 */
export function usernameProblem(name: string, options: { staff?: boolean; short?: boolean } = {}): UsernameProblem | null {
  if (name.length < SHORT_USERNAME_MIN) return "too_short";
  if (name.length > USERNAME_MAX) return "too_long";
  if (!PATTERN.test(name)) return "pattern";
  if (RESERVED.has(name) || BRANDS.has(name) || (!options.staff && STAFF_LIKE.test(name))) return "reserved";
  if (name.length < USERNAME_MIN && !options.short) return "short_plan";
  return null;
}

/** Whether a name is one of the short ones the plan allows. */
export function isShortUsername(name: string): boolean {
  return name.length < USERNAME_MIN;
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

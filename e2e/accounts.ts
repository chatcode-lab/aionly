/**
 * Test accounts per worker process; each test takes the next one. One worker
 * can run a whole project's tests, and those that publish take about a
 * hundred, so this leaves room for them to grow.
 */
export const ACCOUNTS_PER_WORKER = 150;

/**
 * Enough accounts for this many worker processes in one run. Every project
 * and every restart after a failure starts new workers, so this counts
 * workers over the whole run, not those running at once.
 */
export const MAX_WORKERS = 64;

/** The ID of the account under a ban, shared because no test can change it. */
export const BANNED_ACCOUNT = "e2eban";

/** The ID of the admin account, shared: tests act through it, never on it. */
export const ADMIN_ACCOUNT = "e2eadmin";

/** The ID of an account made 30 hours ago, past the new-member offer's 24 hours: shared, only read. */
export const DAY_OLD_ACCOUNT = "e2edayold";

/**
 * Accounts at -120 and -130 karma, below the floor, one of each per worker:
 * the prefix of their IDs. A fresh start changes them, so no two tests share one.
 */
export const LOW_KARMA_ACCOUNT = "e2elow";
export const APPEAL_ACCOUNT = "e2eappeal";

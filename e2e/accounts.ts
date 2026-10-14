/** Test accounts per worker process; each test takes the next one. */
export const ACCOUNTS_PER_WORKER = 50;

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

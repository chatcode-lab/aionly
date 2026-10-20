import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DIRECTORY = new URL("../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);

/**
 * The test server's own local database, to put it in a state the app
 * cannot be driven into from outside, such as a stored picture going
 * missing mid-publication. It is the one `db:prepare:e2e` seeded, holding
 * the test accounts. SQLite's locks keep these writes and the server's
 * apart.
 */
export function localDb(): DatabaseSync {
  for (const file of readdirSync(DIRECTORY).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")) {
    const db = new DatabaseSync(new URL(file, DIRECTORY).pathname);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      if (db.prepare(`SELECT 1 FROM profiles WHERE user_id = 'e2eadmin'`).get()) return db;
    } catch {
      // Another database, without the board's tables.
    }
    db.close();
  }
  throw new Error("The test server's local database was not found; run npm run db:prepare:e2e");
}

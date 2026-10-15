import { newId } from "../ids";
import { generateUsername, usernameProblem } from "../accounts/usernames";
import { type AccountRecord, accountRecord } from "./accounts.server";
import { karmaSql } from "./votes.server";

/** A token looks like this, so a leaked one is easy to spot and search for. */
const TOKEN_PREFIX = "aionly_";

/** Tokens one agent may hold at once, so old ones get revoked. */
export const MAX_TOKENS = 5;

/**
 * Tokens apps connected through OAuth may hold at once; connecting one more
 * revokes the one used longest ago, since apps reconnect without asking.
 */
export const MAX_APP_TOKENS = 10;

/** The longest label a token keeps, such as an app's name. */
const TOKEN_LABEL_LIMIT = 60;

/** How often a token's last use is written, so reading it costs no write. */
const LAST_USED_PRECISION = 3600;

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An owner's agent as Settings shows it. */
export interface OwnedAgent {
  id: string;
  username: string;
  tokens: Array<{ id: string; label: string | null; createdAt: number; lastUsedAt: number | null; app: boolean }>;
}

export async function agentOf(db: D1Database, ownerId: string): Promise<OwnedAgent | null> {
  const agent = await db
    .prepare(
      `SELECT profile.user_id, name.name FROM profiles AS profile
       JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       WHERE profile.owner_id = ?1 AND profile.deleted_at IS NULL`,
    )
    .bind(ownerId)
    .first<{ user_id: string; name: string }>();
  if (!agent) return null;
  const { results } = await db
    .prepare(
      `SELECT id, label, created_at, last_used_at, client_id FROM agent_tokens
       WHERE agent_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .bind(agent.user_id)
    .all<{ id: string; label: string | null; created_at: number; last_used_at: number | null; client_id: string | null }>();
  return {
    id: agent.user_id,
    username: agent.name,
    tokens: results.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      app: row.client_id !== null,
    })),
  };
}

/**
 * Connects a member's one agent: a profile run by them, with no sign-in of
 * its own, sharing their karma. It starts with a name derived from the
 * owner's, or a generated one, and can choose its own through the API.
 */
export async function createAgent(
  db: D1Database,
  input: { ownerId: string; ownerName: string; now: number; staff?: boolean },
): Promise<{ ok: true; agent: OwnedAgent } | { ok: false; reason: "exists" }> {
  if (await agentOf(db, input.ownerId)) return { ok: false, reason: "exists" };
  const id = newId();
  const derived = `${input.ownerName.slice(0, 14)}_agent`;
  const names = [usernameProblem(derived, { staff: input.staff }) ? null : derived, ...Array.from({ length: 8 }, generateUsername)].filter(
    (name): name is string => name !== null,
  );

  // A batch is one transaction: a taken name fails it and leaves nothing.
  for (const name of names) {
    try {
      await db.batch([
        db
          // The agent starts with its owner's karma and floor, which they share.
          .prepare(
            `INSERT INTO profiles (user_id, owner_id, created_at, karma, karma_floor)
             VALUES (?1, ?2, ?3, ${karmaSql("?2")}, (SELECT karma_floor FROM profiles WHERE user_id = ?2))`,
          )
          .bind(id, input.ownerId, input.now),
        db.prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES (?1, ?2, 1, ?3)`).bind(name, id, input.now),
      ]);
      return { ok: true, agent: (await agentOf(db, input.ownerId))! };
    } catch (error) {
      const message = String(error);
      if (message.includes("profiles.owner_id")) return { ok: false, reason: "exists" };
      if (message.includes("usernames.name")) continue;
      throw error;
    }
  }
  throw new Error("could not find a free agent name");
}

/**
 * Makes a token for an agent and returns it, the only time it is ever
 * seen: only its hash is kept. Refused past the most an agent may hold.
 */
export async function createToken(
  db: D1Database,
  input: { agentId: string; label: string | null; now: number },
): Promise<{ ok: true; token: string; id: string } | { ok: false; reason: "too_many" }> {
  const token = `${TOKEN_PREFIX}${newId(40)}`;
  const id = newId();
  const inserted = await db
    .prepare(
      `INSERT INTO agent_tokens (id, agent_id, token_hash, label, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM agent_tokens WHERE agent_id = ?2 AND revoked_at IS NULL AND client_id IS NULL) < ${MAX_TOKENS}`,
    )
    .bind(id, input.agentId, await hashToken(token), input.label, input.now)
    .run();
  return inserted.meta.changes > 0 ? { ok: true, token, id } : { ok: false, reason: "too_many" };
}

/**
 * Makes a token for an app the owner connected through OAuth, named after
 * the app. Past the most apps may hold, the one used longest ago goes.
 */
export async function createAppToken(
  db: D1Database,
  input: { agentId: string; clientId: string; label: string; now: number },
): Promise<string> {
  const token = `${TOKEN_PREFIX}${newId(40)}`;
  await db.batch([
    db
      .prepare(
        `UPDATE agent_tokens SET revoked_at = ?2
         WHERE id IN (
           SELECT id FROM agent_tokens
           WHERE agent_id = ?1 AND client_id IS NOT NULL AND revoked_at IS NULL
           ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
           LIMIT -1 OFFSET ${MAX_APP_TOKENS - 1}
         )`,
      )
      .bind(input.agentId, input.now),
    db
      .prepare(
        `INSERT INTO agent_tokens (id, agent_id, token_hash, label, created_at, client_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(newId(), input.agentId, await hashToken(token), input.label.slice(0, TOKEN_LABEL_LIMIT), input.now, input.clientId),
  ]);
  return token;
}

/** Revokes a token presented by whoever holds it, as RFC 7009 has apps do. */
export async function revokePresentedToken(db: D1Database, token: string, now: number): Promise<void> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return;
  await db
    .prepare(`UPDATE agent_tokens SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL`)
    .bind(await hashToken(token), now)
    .run();
}

/** Revokes one of an owner's agent's tokens; it stops working at once. */
export async function revokeToken(
  db: D1Database,
  input: { ownerId: string; tokenId: string; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE agent_tokens SET revoked_at = ?3
       WHERE id = ?1 AND revoked_at IS NULL
         AND agent_id = (SELECT user_id FROM profiles WHERE owner_id = ?2)`,
    )
    .bind(input.tokenId, input.ownerId, input.now)
    .run();
  return result.meta.changes > 0;
}

/**
 * The agent a bearer token belongs to, or null. A revoked token, a deleted
 * agent, or a deleted owner never authenticates; a banned one does, and its
 * writes are refused like anyone's.
 */
export async function agentForToken(db: D1Database, token: string, now: number): Promise<AccountRecord | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT token.id, token.agent_id, token.last_used_at FROM agent_tokens AS token
       JOIN profiles AS agent ON agent.user_id = token.agent_id
       JOIN profiles AS owner ON owner.user_id = agent.owner_id
       WHERE token.token_hash = ?1 AND token.revoked_at IS NULL
         AND agent.deleted_at IS NULL AND owner.deleted_at IS NULL`,
    )
    .bind(hash)
    .first<{ id: string; agent_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || row.last_used_at < now - LAST_USED_PRECISION) {
    await db.prepare(`UPDATE agent_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(row.id, now).run();
  }
  return accountRecord(db, row.agent_id, now);
}

import { beforeEach, describe, expect, it } from "vitest";

import { authFor } from "../../app/lib/auth.server";
import { sendSignInLink } from "../../app/lib/notices/notices.server";
import { db, reset, user } from "./fixtures";

type Sent = { to: string; subject: string; text: string };

async function hashed(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A sign-in link as Better Auth keeps it, for `email`, made `ago` seconds back. */
async function plantLink(token: string, email: string, ago = 0): Promise<void> {
  const at = new Date(Date.now() - ago * 1000).toISOString();
  await db
    .prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
    .bind(crypto.randomUUID(), `magic-link:${await hashed(token)}`, JSON.stringify({ type: "magic-link", email }), new Date(Date.now() + 600_000).toISOString(), at)
    .run();
}

async function signInWith(token: string): Promise<Response> {
  const headers = new Headers({ Origin: "http://localhost" });
  return authFor(new Request("http://localhost/signin/email", { method: "POST", headers })).api.magicLinkVerify({
    query: { token, callbackURL: "/u/somewhere", errorCallbackURL: "/signin?tab=member" },
    headers,
    asResponse: true,
  });
}

describe("sign-in links", () => {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Parameters<typeof sendSignInLink>[1];
  const now = Math.floor(Date.now() / 1000);

  async function member(id: string, name: string, email: string, fields: Parameters<typeof user>[2] = {}) {
    await user(id, name, fields);
    await db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
      .bind(id, email, new Date().toISOString())
      .run();
  }

  beforeEach(async () => {
    sent.length = 0;
    await reset();
    await db.batch([db.prepare(`DELETE FROM "session"`), db.prepare(`DELETE FROM "verification"`), db.prepare(`DELETE FROM "user"`)]);
  });

  it("go only to a live member's own sign-in email, a few an hour at most", async () => {
    await member("m1", "link_member", "member@aion.ly");
    await member("m2", "gone_member", "gone@aion.ly", { deletedAt: now });
    const link = { url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly", now };
    expect(await sendSignInLink(db, mailer, { ...link, email: " Member@Aion.ly " })).toBe(true);
    expect(sent[0]).toMatchObject({ to: "member@aion.ly", subject: "Your aion.ly sign-in link" });
    expect(await sendSignInLink(db, mailer, { ...link, email: "nobody@aion.ly" })).toBe(false);
    expect(await sendSignInLink(db, mailer, { ...link, email: "gone@aion.ly" })).toBe(false);
    // Four links asked for this hour: no more mail to that address.
    for (const token of ["a", "b", "c", "d"]) await plantLink(`token${token}`.padEnd(32, "x"), "member@aion.ly", 60);
    expect(await sendSignInLink(db, mailer, { ...link, email: "member@aion.ly" })).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("sign a member in once, and never make an account", async () => {
    await member("m1", "link_member", "member@aion.ly");
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf";
    await plantLink(token, "member@aion.ly");
    const first = await signInWith(token);
    expect(first.status).toBe(302);
    expect(first.headers.get("Location")).toBe("http://localhost/u/somewhere");
    expect(first.headers.getSetCookie().join(";")).toMatch(/session_token=/);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = 'm1'`).first()).toEqual({ n: 1 });

    // The same link again: used up.
    const again = await signInWith(token);
    expect(again.headers.get("Location")).toMatch(/error=INVALID_TOKEN/);
    expect(again.headers.getSetCookie().join(";")).not.toMatch(/session_token=[^;]/);

    // A link for an address with no account makes none.
    const stranger = "ZyXwVuTsRqPoNmLkJiHgFeDcBaZyXwVu";
    await plantLink(stranger, "stranger@aion.ly");
    const refused = await signInWith(stranger);
    expect(refused.headers.get("Location")).toMatch(/error=new_user_signup_disabled/);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'stranger@aion.ly'`).first()).toEqual({ n: 0 });
  });
});

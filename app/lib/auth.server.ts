import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";

import { createProfile } from "./db/accounts.server";
import { newId } from "./ids";

// A session lasts 30 days and is extended once a day while in use.
const SESSION_SECONDS = 30 * 24 * 3600;
const SESSION_REFRESH_SECONDS = 24 * 3600;

/**
 * An account's email is its sign-in email for good: required, unique, and
 * kept for a later email sign-in. Only one Google has verified is accepted,
 * so nobody can claim an address that is not theirs.
 */
export function requireVerifiedEmail(user: { email?: string | null; emailVerified?: boolean | null }) {
  if (!user.email || user.emailVerified !== true) {
    throw APIError.from("FORBIDDEN", {
      code: "email_not_verified",
      message: "The Google account's email is not verified.",
    });
  }
}

/** Provider tokens are never kept: the board needs only who signed in. */
function withoutTokens<T extends Record<string, unknown>>(account: T): T {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

function createAuth(origin: string) {
  return betterAuth({
    appName: "aion.ly",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Lets someone with several Google accounts pick the right one.
        prompt: "select_account",
      },
    },
    session: {
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      // Every request reads the session from D1, so signing out, a ban, or a
      // deleted account takes effect at once.
      cookieCache: { enabled: false },
    },
    account: {
      updateAccountOnSignIn: false,
      // Linking a second provider arrives with X; until then one account
      // is one Google identity.
      accountLinking: { enabled: false },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      database: { generateId: () => newId() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            requireVerifiedEmail(user);
          },
          // Every account gets its public profile and a generated name as
          // it is created. A failure here is repaired on the next request.
          after: async (user) => {
            await createProfile(env.DB, user.id);
          },
        },
      },
      account: {
        create: { before: async (account) => ({ data: withoutTokens(account) }) },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per site address. The Worker answers on its own hostnames
// only, so the request's origin is the site's; callbacks then match the
// address the visitor is on, with no hostname kept in configuration.
const instances = new Map<string, Auth>();

export function authFor(request: Request): Auth {
  const origin = new URL(request.url).origin;
  let auth = instances.get(origin);
  if (!auth) {
    auth = createAuth(origin);
    instances.set(origin, auth);
  }
  return auth;
}

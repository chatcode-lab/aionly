import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import type { TwitterProfile } from "@better-auth/core/social-providers";
import { APIError } from "better-auth/api";

import { accountRecord, createProfile } from "./db/accounts.server";
import { signUpRefusal } from "./db/deletion.server";
import { attachInvite, claimInvite } from "./db/invites.server";
import { INVITE_CODE, INVITE_COOKIE } from "./invites";
import { rememberXAccount, type XProfile } from "./db/x-accounts.server";
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

/** Whether a new account needs an invitation, as it does unless sign-up is opened. */
export function invitesRequired(): boolean {
  return env.OPEN_SIGNUP !== "true";
}

/** The invitation this browser carries, from its invitation link. */
export function inviteFrom(request: Request | undefined): string | null {
  const cookie = request?.headers.get("Cookie") ?? "";
  const code = new RegExp(`(?:^|;\\s*)${INVITE_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? null;
  return code && INVITE_CODE.test(code) ? code : null;
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

/** X linking is offered once the board's X app is configured. */
export function xConfigured(): boolean {
  return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
}

/**
 * X's sign-in, for linking an X account and signing in with a linked one.
 * It reads the profile once, with the photo's address, which X bills as one
 * user read; X's own provider would read it twice to look for an email,
 * which the board does not need. It never creates an account.
 */
function xProvider(seen: (profile: XProfile) => void) {
  return {
    clientId: env.X_CLIENT_ID!,
    clientSecret: env.X_CLIENT_SECRET!,
    disableDefaultScope: true,
    scope: ["users.read", "tweet.read"],
    disableSignUp: true,
    getUserInfo: async (token: { accessToken?: string }) => {
      const response = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
        headers: { Authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const profile = (await response.json()) as TwitterProfile;
      const data = profile.data;
      if (!data?.id) return null;
      seen({ id: data.id, handle: data.username, photoUrl: data.profile_image_url ?? null });
      return {
        // An address that is never anyone's, so it can never match an account by email.
        user: { name: data.name, email: `x-${data.id}@x.invalid`, emailVerified: false },
        // The account is keyed by the X ID in here.
        data: profile,
      };
    },
  };
}

function createAuth(origin: string, request?: Request) {
  // What X said in this request, for the hooks below. The instance serves
  // one request only, so this is never shared.
  let seenX: XProfile | null = null;
  const x = xConfigured();
  return betterAuth({
    appName: "aion.ly",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    user: {
      // A Google account whose board account was deleted lately, or deleted
      // while banned, cannot make a new one; see the plan's "Account
      // deletion". This runs before anything is written.
      validateUserInfo: async ({ source }) => {
        const accountId = source.oauth?.profile?.sub;
        if (source.oauth?.providerId !== "google" || typeof accountId !== "string") return;
        const refusal = await signUpRefusal(env.DB, {
          secret: env.BETTER_AUTH_SECRET,
          provider: "google",
          accountId,
          now: Math.floor(Date.now() / 1000),
        });
        if (refusal) return { error: refusal === "banned" ? "identity_banned" : "identity_deleted" };
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Lets someone with several Google accounts pick the right one.
        prompt: "select_account",
      },
      ...(x ? { twitter: xProvider((profile) => (seenX = profile)) } : {}),
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
      // An X account is linked only on purpose, from Settings: never by a
      // matching email at sign-in. A Google account is still one account.
      accountLinking: x
        ? { enabled: true, trustedProviders: ["twitter"], allowDifferentEmails: true, disableImplicitLinking: true }
        : { enabled: false },
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
            // New members come by invitation: the link's code, claimed for
            // this email inside the write, so one invitation makes one account.
            if (invitesRequired()) {
              const code = inviteFrom(request);
              const claimed = code ? await claimInvite(env.DB, { code, email: user.email!, now: Math.floor(Date.now() / 1000) }) : false;
              if (!claimed) {
                throw APIError.from("FORBIDDEN", {
                  code: code ? "invite_invalid" : "invite_required",
                  message: "A new account needs an invitation from a member.",
                });
              }
            }
          },
          // Every account gets its public profile and a generated name as
          // it is created, and who invited it. A failure here is repaired on
          // the next request.
          after: async (user) => {
            await createProfile(env.DB, user.id);
            await attachInvite(env.DB, { userId: user.id, email: user.email });
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            // Linking X is a Supporter feature, whichever way it is asked for.
            if (account.providerId === "twitter") {
              const member = await accountRecord(env.DB, account.userId);
              if (!member?.entitled || member.ownerId) {
                throw APIError.from("FORBIDDEN", { code: "plan_required", message: "Linking X comes with the Supporter plan." });
              }
            }
            return { data: withoutTokens(account) };
          },
          after: async (account) => {
            if (account.providerId === "twitter" && seenX) await rememberXAccount(env.DB, account.userId, seenX);
          },
        },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
      // Signing in with X refreshes the handle and photo the profile shows.
      session: {
        create: {
          after: async (session) => {
            if (seenX) await rememberXAccount(env.DB, session.userId, seenX);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth for one request. A new instance each time: an instance keeps
 * promises made while serving the request that created it, and Workers
 * refuse to let another request use them. The request's origin is the
 * site's, since the Worker answers on its own hostnames only, so callbacks
 * match the address the visitor is on with no hostname in configuration.
 */
export function authFor(request: Request): Auth {
  return createAuth(new URL(request.url).origin, request);
}

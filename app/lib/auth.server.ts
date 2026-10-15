import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import type { TwitterProfile } from "@better-auth/core/social-providers";
import { APIError } from "better-auth/api";

import { createProfile, linkedWith } from "./db/accounts.server";
import { signUpRefusal } from "./db/deletion.server";
import { attachInvite, claimInvite } from "./db/invites.server";
import { INVITE_COOKIE, normalizeInviteCode } from "./invites";
import { rememberXAccount, type XProfile } from "./db/x-accounts.server";
import { newId } from "./ids";

// A session lasts 30 days and is extended once a day while in use.
const SESSION_SECONDS = 30 * 24 * 3600;
const SESSION_REFRESH_SECONDS = 24 * 3600;

/**
 * An account's email is the one it signed up with, for good: required,
 * unique, and kept for a later email sign-in. Only one Google or X has
 * verified is accepted, so nobody can claim an address that is not theirs.
 * A method linked later keeps its own email to itself.
 */
export function requireVerifiedEmail(user: { email?: string | null; emailVerified?: boolean | null }) {
  if (!user.email || user.emailVerified !== true) {
    throw APIError.from("FORBIDDEN", {
      code: "email_not_verified",
      message: "The sign-in did not share a verified email.",
    });
  }
}

/** Whether a new account needs an invitation, as it does unless sign-up is opened. */
export function invitesRequired(): boolean {
  return env.OPEN_SIGNUP !== "true";
}

/** The invitation this browser carries, from its invitation link or code. */
export function inviteFrom(request: Request | undefined): string | null {
  const cookie = request?.headers.get("Cookie") ?? "";
  const code = new RegExp(`(?:^|;\\s*)${INVITE_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? null;
  return code ? normalizeInviteCode(code) : null;
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

/** Signing in with X is offered once the board's X app is configured. */
export function xConfigured(): boolean {
  return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
}

/**
 * X's sign-in, for making an account, signing in, and linking X to an
 * account made with Google. It reads the profile once, with the photo's
 * address and the email X has confirmed, which X bills as one user read;
 * X's own provider would read it twice. An X account without a confirmed
 * email can still sign in to an account it is linked to, but cannot make one.
 */
function xProvider(seen: (profile: XProfile) => void) {
  return {
    clientId: env.X_CLIENT_ID!,
    clientSecret: env.X_CLIENT_SECRET!,
    disableDefaultScope: true,
    scope: ["users.read", "tweet.read", "users.email"],
    getUserInfo: async (token: { accessToken?: string }) => {
      const read = (fields: string) =>
        fetch(`https://api.x.com/2/users/me?user.fields=${fields}`, {
          headers: { Authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(5000),
        });
      let response = await read("profile_image_url,confirmed_email");
      // X refuses the whole read when the email is not granted, as for an
      // app without email access: read the profile alone, with no email.
      if (response.status === 400 || response.status === 403) {
        console.error("x users/me with email", response.status, await xProblem(response));
        response = await read("profile_image_url");
      }
      if (!response.ok) {
        // 402 means the X app has no credits left; 401 or 403, that the app's settings refuse it.
        console.error("x users/me", response.status, await xProblem(response));
        return null;
      }
      const profile = (await response.json()) as TwitterProfile & { data?: { confirmed_email?: string } };
      const data = profile.data;
      if (!data?.id) return null;
      seen({ id: data.id, handle: data.username, photoUrl: data.profile_image_url ?? null });
      const email = typeof data.confirmed_email === "string" && data.confirmed_email.includes("@") ? data.confirmed_email.toLowerCase() : null;
      return {
        // Without a confirmed email, an address that is never anyone's, so
        // it matches no account and makes none.
        user: { name: data.name, email: email ?? `x-${data.id}@x.invalid`, emailVerified: email !== null },
        // The account is keyed by the X ID in here.
        data: profile,
      };
    },
  };
}

/** What X said when it refused a read, briefly, for the logs. It holds no tokens. */
async function xProblem(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** The ID a sign-in's provider gives the person, from the profile it returned. */
function providerAccountId(oauth: { providerId?: string; profile?: unknown } | undefined): string | null {
  const profile = oauth?.profile as { sub?: unknown; data?: { id?: unknown } } | undefined;
  const id = oauth?.providerId === "google" ? profile?.sub : oauth?.providerId === "twitter" ? profile?.data?.id : null;
  return typeof id === "string" ? id : null;
}

function createAuth(origin: string, request?: Request) {
  // What X said in this request, for the hooks below. The instance serves
  // one request only, so this is never shared.
  let seenX: XProfile | null = null;
  // Whether this request is making an account, for the hooks below.
  let signingUp = false;
  const x = xConfigured();
  return betterAuth({
    appName: "aion.ly",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    user: {
      // A Google or X account whose board account was deleted lately, or
      // deleted while banned, can neither make a new one nor be linked to
      // another; see the plan's "Account deletion". This runs before
      // anything is written.
      validateUserInfo: async ({ source }) => {
        const provider = source.oauth?.providerId;
        const accountId = providerAccountId(source.oauth);
        if (!provider || !accountId) return;
        const refusal = await signUpRefusal(env.DB, {
          secret: env.BETTER_AUTH_SECRET,
          provider,
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
      // A second sign-in method is linked only on purpose, from Settings,
      // whatever its email: never by a matching email at sign-in.
      accountLinking: x
        ? { enabled: true, trustedProviders: ["google", "twitter"], allowDifferentEmails: true, disableImplicitLinking: true }
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
            signingUp = true;
            // The account's ID is drawn here, so its invitation is claimed
            // for this account and no other.
            const id = newId();
            // New members come by invitation: the link's code, claimed
            // inside the write, so one invitation makes one account.
            if (invitesRequired()) {
              const code = inviteFrom(request);
              const claimed = code ? await claimInvite(env.DB, { code, userId: id, now: Math.floor(Date.now() / 1000) }) : false;
              if (!claimed) {
                throw APIError.from("FORBIDDEN", {
                  code: code ? "invite_invalid" : "invite_required",
                  message: "A new account needs an invitation from a member.",
                });
              }
            }
            return { data: { ...user, id } };
          },
          // Every account gets its public profile and a generated name as
          // it is created, and who invited it. A failure here is repaired on
          // the next request, or by the hourly sweep.
          after: async (user) => {
            await createProfile(env.DB, user.id);
            await attachInvite(env.DB, { userId: user.id });
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            // One Google account and one X account at most, each linked to
            // one board account (Better Auth checks that).
            if (await linkedWith(env.DB, account.userId, account.providerId)) {
              throw APIError.from("FORBIDDEN", { code: "provider_linked", message: "This account already has one of these linked." });
            }
            return { data: withoutTokens(account) };
          },
          after: async (account) => {
            // X linked on purpose, from Settings, shows on the profile until
            // hidden; an account made with X keeps it hidden until shown.
            if (account.providerId === "twitter" && seenX) {
              await rememberXAccount(env.DB, account.userId, seenX, { shown: !signingUp });
            }
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

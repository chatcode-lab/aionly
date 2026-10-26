import { env, waitUntil } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { google, type TwitterProfile } from "@better-auth/core/social-providers";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";

import { accountRecord, createProfile, linkedWith } from "./db/accounts.server";
import { signUpRefusal } from "./db/deletion.server";
import { attachInvite, claimInvite } from "./db/invites.server";
import { attachPartner, claimPartnerJoin } from "./db/partners.server";
import { DIGEST_COOKIE, type Frequency, frequencyOf } from "./digest/frequency";
import { INVITE_COOKIE, normalizeInviteCode } from "./invites";
import { normalizePartnerCode, PARTNER_COOKIE } from "./partners";
import { rememberXAccount, type XProfile } from "./db/x-accounts.server";
import { newId } from "./ids";
import { transactionalMailer } from "./mail/mailers.server";
import { SIGN_IN_LINK_MINUTES } from "./notices/notices";
import { sendSignInLink } from "./notices/notices.server";

// A session lasts 30 days and is extended once a day while in use.
const SESSION_SECONDS = 30 * 24 * 3600;
const SESSION_REFRESH_SECONDS = 24 * 3600;

/**
 * An account's email is its Google sign-in email, for good: required,
 * unique, and kept for a later email sign-in. Only one Google has verified
 * is accepted, so nobody can claim an address that is not theirs.
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

/** The invitation this browser carries, from its invitation link or code. */
export function inviteFrom(request: Request | undefined): string | null {
  const cookie = request?.headers.get("Cookie") ?? "";
  const code = new RegExp(`(?:^|;\\s*)${INVITE_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? null;
  return code ? normalizeInviteCode(code) : null;
}

/** The partner link this browser carries, from `/join/<code>`. */
export function partnerFrom(request: Request | undefined): string | null {
  const cookie = request?.headers.get("Cookie") ?? "";
  const code = new RegExp(`(?:^|;\\s*)${PARTNER_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? null;
  return code ? normalizePartnerCode(code) : null;
}

/** The digest this browser chose on its way in, from the invitation to the digest. */
export function digestFrom(request: Request | undefined): Frequency | null {
  const cookie = request?.headers.get("Cookie") ?? "";
  return frequencyOf(new RegExp(`(?:^|;\\s*)${DIGEST_COOKIE}=([^;]+)`).exec(cookie)?.[1]);
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

/**
 * Whether the Google account's photo is Google's default, a letter on a
 * color, by the People API's own flag. Unknown, as when the API is not
 * enabled for the board's Google project, counts as a photo of their own.
 */
export async function googlePhotoIsDefault(accessToken: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("https://people.googleapis.com/v1/people/me?personFields=photos", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error("google people api", response.status);
      return false;
    }
    const { photos = [] } = (await response.json()) as { photos?: Array<{ default?: boolean; metadata?: { primary?: boolean } }> };
    const photo = photos.find((entry) => entry.metadata?.primary) ?? photos[0];
    return photo?.default === true;
  } catch (error) {
    console.error("google people api", error);
    return false;
  }
}

/** Linking X is offered once the board's X app is configured. */
export function xConfigured(): boolean {
  return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
}

/**
 * X's own sign-in: to link an X account to a fan's board account, and then
 * to sign in to that account with it. It never makes an account. It reads
 * the profile once, with the photo's address, which X bills as one user
 * read; X's own provider would read it twice to look for an email, which
 * the board does not need.
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
      if (!response.ok) {
        // 402: the X app has no credits; 403 client-not-enrolled: it is not in a Project.
        console.error("x users/me", response.status, await xProblem(response));
        return null;
      }
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
  const x = xConfigured();
  // Better Auth's own reading of Google's sign-in, which the board's wraps.
  const googleProfile = google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  return betterAuth({
    appName: "aion.ly",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    user: {
      // A Google account whose board account was deleted lately, or deleted
      // while banned, cannot make a new one, nor can such an X account be
      // linked to another; see the plan's "Account deletion". This runs
      // before anything is written.
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
        // Google's letter picture for an account without a photo is not
        // kept as one: Settings then offers no Google photo to use.
        getUserInfo: async (token) => {
          const info = await googleProfile.getUserInfo(token);
          if (!info?.user.image || !token.accessToken) return info;
          return (await googlePhotoIsDefault(token.accessToken)) ? { ...info, user: { ...info.user, image: undefined } } : info;
        },
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
      // An X account is linked only on purpose, from Settings, whatever its
      // email: never by a matching email at sign-in. Accounts are made with Google only.
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
            // The account's ID is drawn here, so its invitation is claimed
            // for this account and no other.
            const id = newId();
            // New members come by invitation: the link's code, claimed
            // inside the write, so one invitation makes one account; or by
            // a partner's link, good for many. A partner's link counts with
            // open sign-up too, for the partner's share.
            const now = Math.floor(Date.now() / 1000);
            const code = inviteFrom(request);
            const partner = partnerFrom(request);
            const invited = code ? await claimInvite(env.DB, { code, userId: id, now }) : false;
            const joined = !invited && partner ? await claimPartnerJoin(env.DB, { code: partner, userId: id, now }) : false;
            if (invitesRequired() && !invited && !joined) {
              throw APIError.from("FORBIDDEN", {
                code: code || partner ? "invite_invalid" : "invite_required",
                message: "A new account needs an invitation from a member.",
              });
            }
            return { data: { ...user, id } };
          },
          // Every account gets its public profile and a generated name as
          // it is created, with the digest chosen on the way in, and who
          // invited it. A failure here is repaired on the next request, or
          // by the hourly sweep.
          after: async (user) => {
            await createProfile(env.DB, user.id, Math.floor(Date.now() / 1000), digestFrom(request) ?? undefined);
            await attachInvite(env.DB, { userId: user.id });
            await attachPartner(env.DB, { userId: user.id });
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (account.providerId === "twitter") {
              // Linking X is a Fan feature, for members, however it is asked for.
              const member = await accountRecord(env.DB, account.userId);
              if (!member?.entitled || member.ownerId) {
                throw APIError.from("FORBIDDEN", { code: "plan_required", message: "Linking X comes with the Fan plan." });
              }
              // A ban, or karma at its floor, that landed while X was asking.
              if (member.ban) {
                throw APIError.from("FORBIDDEN", { code: "read_only", message: "A read-only account cannot link X." });
              }
            }
            // One account of each kind at most, each linked to one board account (Better Auth checks that).
            if (await linkedWith(env.DB, account.userId, account.providerId)) {
              throw APIError.from("FORBIDDEN", { code: "provider_linked", message: "This account already has one of these linked." });
            }
            return { data: withoutTokens(account) };
          },
          after: async (account) => {
            // Linked on purpose, to be shown, until the member hides it;
            // written only while this link's own sign-in record remains.
            if (account.providerId === "twitter" && seenX) {
              await rememberXAccount(env.DB, { id: account.id, userId: account.userId }, seenX, { shown: true });
            }
          },
        },
        update: { before: async (account) => ({ data: withoutTokens(account) }) },
      },
    },
    plugins: [
      // A sign-in link by email, for accounts that exist: never a new one.
      // The link leads to the board's own page, which posts itself to finish
      // the sign-in, so a mail scanner that only fetches it uses nothing up.
      magicLink({
        disableSignUp: true,
        storeToken: "hashed",
        expiresIn: SIGN_IN_LINK_MINUTES * 60,
        sendMagicLink: async ({ email, url, token }) => {
          const next = new URL(url).searchParams.get("callbackURL") ?? "/";
          const link = `${origin}/signin/email?${new URLSearchParams({ token, next })}`;
          const send = { email, url: link, origin, now: Math.floor(Date.now() / 1000), secret: env.BETTER_AUTH_SECRET };
          waitUntil(sendSignInLink(env.DB, transactionalMailer(), send).catch((error) => console.error("sign-in link", error)));
        },
      }),
    ],
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

/**
 * Starts a sign-in with Google or X: the browser goes on to the provider
 * with the cookie Better Auth sets to tie the callback to it, and any of
 * `cookies`. Null when it could not start.
 */
export async function startSignIn(
  request: Request,
  body: NonNullable<Parameters<Auth["api"]["signInSocial"]>[0]>["body"],
  cookies: string[] = [],
): Promise<Response | null> {
  const response = await authFor(request).api.signInSocial({ body: { ...body, disableRedirect: true }, headers: request.headers, asResponse: true });
  if (!response.ok) return null;
  const { url } = (await response.json()) as { url: string };
  const headers = new Headers({ Location: url });
  for (const cookie of [...response.headers.getSetCookie(), ...cookies]) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * Continue with Google, which makes the account too where it may: a new
 * one comes back through the welcome step, a member to `next`.
 */
export function googleSignIn(request: Request, next: string, cookies: string[] = []): Promise<Response | null> {
  return startSignIn(
    request,
    {
      provider: "google",
      callbackURL: next,
      newUserCallbackURL: `/welcome?${new URLSearchParams({ next })}`,
      errorCallbackURL: `/signin?${new URLSearchParams({ next })}`,
    },
    cookies,
  );
}

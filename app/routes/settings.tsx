import { env } from "cloudflare:workers";
import { useId, useState } from "react";
import { Heart } from "lucide-react";
import { Form, Link, redirect, useActionData, useFetcher, useNavigation } from "react-router";

import { Avatar } from "~/components/avatar";
import { CodeBlock } from "~/components/code-block";
import { DIGEST_LABELS, DIGESTS, type Digest } from "~/components/digest-menu";
import { PriceLine } from "~/components/plan-paywall";
import { PermissionChoice } from "~/components/permission-choice";
import { FanMark } from "~/components/post-card";
import { CopyButton, XLogo } from "~/components/sign-in";
import { RepliesField } from "~/components/replies-field";
import { DisplaySettings, useTextSize, useTheme, useTint } from "~/components/theme-switch";
import { UsernameForm } from "~/components/username-form";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { TextArea } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { applyRename } from "~/lib/accounts/rename.server";
import {
  ALLOWANCE_USERNAME_MIN,
  SHORT_USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PROBLEM,
  YEARLY_USERNAME_MIN,
} from "~/lib/accounts/usernames";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import { authFor, xConfigured } from "~/lib/auth.server";
import { billingOpen, cancelForDeletion, keepPlan, quoteYearly, switchPlan } from "~/lib/billing/plan.server";
import { type AccountRecord, nameFreeFor, renameStatus, setTextSize, setTint } from "~/lib/db/accounts.server";
import { agentOf, createAgent, createToken, MAX_TOKENS, type OwnedAgent, revokeToken, setTokenPermission } from "~/lib/db/agents.server";
import { setReplyChoices } from "~/lib/db/authoring.server";
import { deleteReleasedFiles } from "~/lib/db/draft-files.server";
import { createInvite, type InviteStanding, inviteStanding, revokeInvite } from "~/lib/db/invites.server";
import { inviteRefusal, inviteShareWords } from "~/lib/invites";
import { shareWords } from "~/lib/partners";
import { loadSettings } from "~/lib/db/settings.server";
import { useSettings } from "~/lib/use-settings";
import { INTRO_PRICES, PLAN_END_STOPS, PLAN_PRICES, type PlanInterval, shortNameUncertain, WITHDRAWAL_DAYS } from "~/lib/plan";
import type { Settings } from "~/lib/settings";
import { deleteAccount, identityHash } from "~/lib/db/deletion.server";
import { describeWatch, watchListOf } from "~/lib/db/updates.server";
import { planStatus, type PlanStatus, setShowMark } from "~/lib/db/subscriptions.server";
import { clearStaleX, type LinkedX, linkedX, setXShown, unlinkMethod } from "~/lib/db/x-accounts.server";
import { formatAgo, formatDate, formatMoney } from "~/lib/format";
import { setGooglePhoto, setXPhoto } from "~/lib/images.server";
import { imageAddress } from "~/lib/media.server";
import { type Permission, PERMISSION_LABELS, PERMISSIONS, parsePermission } from "~/lib/permissions";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { useViewer } from "~/lib/use-viewer";
import { privatePageMeta } from "~/lib/meta";
import { setOffers } from "~/lib/offers/offers.server";
import { giftStanding, setShowGift } from "~/lib/db/fund.server";
import { partnerStanding, type PartnerStanding } from "~/lib/db/partners.server";
import { currentEditor, forgetEditor, picksOfTerm, setFocus } from "~/lib/db/editors.server";
import { FOCUS_MAX } from "~/lib/editors";
import { sendOffersSoon } from "~/lib/offers/send.server";
import { parseTextSize, TEXT_SIZE_FIELD } from "~/lib/text-size";
import { parseTint, TINT_FIELD } from "~/lib/tint";
import { readTheme } from "~/lib/theme";
import { setupPrompt } from "~/lib/agents/setup";
import { cn } from "~/lib/cn";
import { COMMENT_REPLIES, type CommentReplies, parseCommentReplies, parsePostChoice, POST_CHOICES, type PostChoice } from "~/lib/replies";

import type { Route } from "./+types/settings";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Settings", location.pathname);
}

/** What a failed X link came back with. */
const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user: "That X account is already linked to another account here.",
  provider_linked: "An X account is already linked here.",
  access_denied: "Linking was cancelled on X.",
  identity_deleted: "That X account's board account was deleted in the last 30 days, so it cannot be linked yet.",
  identity_banned: "That X account cannot be linked here.",
  unable_to_get_user_info: "X did not share the account's details. The board's X app may be out of credits or not in a Project.",
  plan_required: "Linking X comes with the Fan plan.",
  read_only: "Your account is read-only, so it cannot link X now.",
  invalid_code: "X did not accept the sign-in. The board's X app settings may not match.",
  state_mismatch: "The link started in another tab or expired. Try again from here.",
  please_restart_the_process: "The link started in another tab or expired. Try again from here.",
};

/** A failed link's message, naming the reason when there is no plainer one. */
function linkErrorMessage(code: string): string {
  return LINK_ERRORS[code] ?? `That did not link (${code.replace(/[^\w.-]/g, "").slice(0, 60) || "unknown"}). Try again in a moment.`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const linkError = url.searchParams.get("link") === "error" ? (url.searchParams.get("error") ?? "") : null;
  // Every section's state, read at once rather than one after another.
  const [status, google, invites, agent, linked, gift, editing, partner, billing] = await Promise.all([
    renameStatus(env.DB, viewer.id),
    // The one page that shows the account's email, and only to its owner.
    env.DB.prepare(
      `SELECT "email", "image" IS NOT NULL AS has_photo,
         (SELECT offers_off_at FROM profiles WHERE user_id = "user"."id") AS offers_off_at
       FROM "user" WHERE "id" = ?1`,
    )
      .bind(viewer.id)
      .first<{ email: string; has_photo: number; offers_off_at: number | null }>(),
    inviteStanding(env.DB, viewer.id, now),
    agentOf(env.DB, viewer.id).then(async (agent) =>
      agent ? { ...agent, watching: await describeWatch(env.DB, await watchListOf(env.DB, agent.id)) } : null,
    ),
    // Details left from an account no longer linked are forgotten first.
    clearStaleX(env.DB, viewer.id).then(() => linkedX(env.DB, viewer.id)),
    giftStanding(env.DB, viewer.id),
    currentEditor(env.DB, now).then(async (term) =>
      term && term.userId === viewer.id ? { term, picks: await picksOfTerm(env.DB, term.id) } : null,
    ),
    partnerStanding(env.DB, viewer.id, now),
    planStatus(env.DB, viewer.id),
  ]);
  return {
    id: viewer.id,
    username: viewer.username,
    email: google?.email ?? "",
    theme: readTheme(request.headers.get("Cookie")),
    invites,
    origin: url.origin,
    photoUrl: viewer.avatarKey ? imageAddress(viewer.avatarKey) : undefined,
    hasGooglePhoto: google?.has_photo === 1,
    // When the member turned offers by email off, or null while they are on.
    offersOffSince: google?.offers_off_at ?? null,
    banned: viewer.ban !== null,
    firstChange: status.firstChange,
    nextChangeAt: status.nextChangeAt,
    planChange: status.planChange,
    planChangeLeft: status.planChangeLeft,
    // The shortest name the member may hold: 5 with the yearly plan, 4
    // with the Short username package or as an admin, else 6.
    shortestName: viewer.shortestName,
    // Connecting an agent comes with the plan; admins need no plan. An
    // agent kept from a lapsed plan is shown, paused.
    canHaveAgent: viewer.entitled,
    agent,
    x: {
      configured: xConfigured(),
      linked,
      error: linkError === null ? undefined : linkErrorMessage(linkError),
    },
    commentReplies: viewer.replyPolicy,
    postReplies: viewer.postReplies,
    // What the member's fresh starts gave to the fund, and whether it shows.
    gift,
    // The running term, for its guest editor: the focus, and the picks.
    editing,
    // A partner's links, what they brought, and the share earned and paid.
    partner,
    plan: {
      fan: viewer.fan,
      admin: viewer.role === "admin",
      showMark: viewer.showMark,
      ...billing,
    },
  };
}

const TOKEN_LABEL_MAX = 40;


/** What a change to the agent answers: a problem, or a new token to show once. */
type AgentResult = { agentError: string | undefined; newToken?: string };

/**
 * Revoking one of the agent's tokens or apps, or changing what it may do.
 * Allowed whatever the account's plan or standing, so an owner can always
 * rein their agent in; allowing more needs the plan and good standing,
 * which setTokenPermission checks.
 */
async function restrictAction(viewer: AccountRecord, form: FormData): Promise<AgentResult> {
  const now = Math.floor(Date.now() / 1000);
  const tokenId = String(form.get("token") ?? "");
  if (form.get("intent") === "token-permission") {
    const permission = parsePermission(form.get("permission"));
    if (!permission) return { agentError: "Choose what it may do." };
    const changed = await setTokenPermission(env.DB, { ownerId: viewer.id, tokenId, permission, now });
    if (changed) return { agentError: undefined };
    return { agentError: viewer.entitled && !viewer.ban ? "That token is already gone." : "Allowing more comes with the Fan plan, in good standing." };
  }
  const revoked = await revokeToken(env.DB, { ownerId: viewer.id, tokenId, now });
  return { agentError: revoked ? undefined : "That token is already gone." };
}

/** Connecting the agent, and making its tokens. */
async function agentAction(viewer: AccountRecord, form: FormData): Promise<AgentResult> {
  if (!viewer.entitled) return { agentError: "Agents come with the Fan plan." };
  const now = Math.floor(Date.now() / 1000);
  const intent = form.get("intent");
  if (intent === "agent-create") {
    const result = await createAgent(env.DB, { ownerId: viewer.id, ownerName: viewer.username, now, staff: viewer.role === "admin" });
    if (result.ok) return { agentError: undefined };
    return { agentError: result.reason === "exists" ? "You already have an agent." : "Agents come with the Fan plan." };
  }
  const agent = await agentOf(env.DB, viewer.id);
  if (!agent) return { agentError: "Connect an agent first." };
  if (intent === "token-create") {
    const label = String(form.get("label") ?? "").trim().slice(0, TOKEN_LABEL_MAX) || null;
    // A token only reads unless the owner chooses more.
    const permission = parsePermission(form.get("permission")) ?? "read_only";
    const result = await createToken(env.DB, { agentId: agent.id, label, permission, now });
    if (result.ok) return { agentError: undefined, newToken: result.token };
    return {
      agentError:
        result.reason === "too_many" ? `An agent holds at most ${MAX_TOKENS} tokens. Revoke one first.` : "Your agent can't take a new token now.",
    };
  }
  return { agentError: "That was not understood." };
}

/**
 * Deletes the account, which a ban does not prevent. The sign-in records go
 * at once and the session with them; see deleteAccount for what stays.
 */
async function deleteAccountAction(request: Request, viewer: AccountRecord, form: FormData) {
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== viewer.username) {
    return { deleteError: `Type ${viewer.username} to confirm.` };
  }
  const { results } = await env.DB.prepare(`SELECT "providerId", "accountId" FROM "account" WHERE "userId" = ?1`)
    .bind(viewer.id)
    .all<{ providerId: string; accountId: string }>();
  const identities = await Promise.all(
    results.map((row) => identityHash(env.BETTER_AUTH_SECRET, row.providerId, row.accountId)),
  );
  // A running plan is cancelled first, so a deleted account is never charged.
  let hold: { release: () => Promise<void> };
  try {
    hold = await cancelForDeletion(viewer.id);
  } catch (error) {
    console.error("stripe cancel on deletion", error);
    return { deleteError: "Your plan could not be cancelled just now, so nothing was deleted. Try again in a few minutes." };
  }
  // Its files, queued in the same write, to delete from the bucket.
  let files: string[];
  let signedOut: Response;
  try {
    // Signing out first gets the headers that clear the cookie.
    signedOut = await authFor(request).api.signOut({ headers: request.headers, asResponse: true });
    files = await deleteAccount(env.DB, {
      userId: viewer.id,
      content: form.get("content") === "on",
      banned: viewer.ban !== null,
      identities,
      now: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    // Nothing was deleted, so checkouts may be made again.
    await hold.release();
    throw error;
  }
  await deleteReleasedFiles(env.DB, env.IMAGES, files);
  const headers = new Headers();
  for (const cookie of signedOut.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return redirect("/deleted", { headers });
}

/**
 * Switching between monthly and yearly: up to yearly now, at the amount
 * quoted first, down to monthly when the year ends. Or keeping the plan as
 * it is.
 */
async function planAction(viewer: AccountRecord, form: FormData, planIntent: "plan-quote" | "plan-switch" | "plan-keep") {
  if (!billingOpen()) return { planError: "Payments open soon." };
  const busy = "Another change to your plan is being made. Try again in a minute.";
  const refused = (reason: "no_plan" | "ending" | "same" | "trial" | "busy", to: PlanInterval) =>
    reason === "ending"
      ? "Your plan is set to end. Renew it in Manage billing first, then switch."
      : reason === "same"
        ? `Your plan is ${to === "year" ? "yearly" : "monthly"} already.`
        : reason === "trial"
          ? "Your plan is in a trial. Switching opens once it is paid for."
          : reason === "busy"
            ? busy
            : "There is no running plan to switch.";
  try {
    if (planIntent === "plan-keep") {
      return (await keepPlan(viewer)) ? { planNotice: "Your plan stays as it is." } : { planError: busy };
    }
    if (planIntent === "plan-quote") {
      const quote = await quoteYearly(viewer);
      return quote.ok ? { planQuote: { cents: quote.cents, taxed: quote.taxed, at: quote.at } } : { planError: refused(quote.reason, "year") };
    }
    const to = form.get("to");
    if (to !== "month" && to !== "year") return { planError: "That was not understood." };
    const later = form.get("at") === "period_end";
    const at = Number(form.get("at"));
    const result = await switchPlan(viewer, to, later ? "period_end" : Number.isInteger(at) && at > 0 ? at : undefined);
    if (result.ok) {
      return {
        planNotice:
          to === "month" || later
            ? `Your plan switches to ${to === "year" ? "yearly" : "monthly"} when this period ends.`
            : "Your plan is yearly now. The receipt is under Manage billing.",
      };
    }
    if (result.reason === "stale") return { planError: "That amount was worked out a while ago. Choose Switch to yearly again to see it as of now." };
    if (result.reason === "confirm") {
      return {
        planError: "Your bank asks to confirm this payment, which can't be done here. Nothing was charged, and your plan stays monthly. You can switch when this month ends instead.",
        planLater: true,
      };
    }
    if (result.reason === "declined") {
      return {
        planError: `${result.message ?? "The payment did not go through."} Nothing was charged, and your plan stays monthly. Check your card under Manage billing, then try again.`,
      };
    }
    return { planError: refused(result.reason, to) };
  } catch (error) {
    console.error("plan switch", error);
    return { planError: "That did not go through. Try again in a minute." };
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "account-delete") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { deleteError: RATE_LIMITED_MESSAGE };
    return deleteAccountAction(request, account, form);
  }
  // Offers by email: on unless the member turns them off.
  if (form.get("intent") === "offers") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { offersError: RATE_LIMITED_MESSAGE };
    const on = form.get("offers") === "on";
    await setOffers(env.DB, account.id, on, Math.floor(Date.now() / 1000));
    // A new member's offer, if their day is not over.
    if (on) sendOffersSoon(account.id, new URL(request.url).origin);
    return { offersSaved: true };
  }
  // The guest editor's note on the term's focus.
  if (form.get("intent") === "focus") {
    const account = await requireParticipant(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { focusError: RATE_LIMITED_MESSAGE };
    const focus = String(form.get("focus") ?? "").trim().slice(0, FOCUS_MAX);
    const saved = await setFocus(env.DB, { editorId: account.id, focus: focus || null, now: Math.floor(Date.now() / 1000) });
    forgetEditor();
    return saved ? { focusSaved: true } : { focusError: "Your term is over, so the focus can no longer change." };
  }
  // The member's text size, for every page and email, whatever their standing.
  if (form.get("intent") === TEXT_SIZE_FIELD) {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { textSizeError: RATE_LIMITED_MESSAGE };
    const size = parseTextSize(form.get(TEXT_SIZE_FIELD));
    if (!size) return { textSizeError: "Choose one of the sizes." };
    await setTextSize(env.DB, account.id, size);
    return { textSizeSaved: true };
  }

  // A fan's tint; back to orange works without the plan, as a banned member may.
  if (form.get("intent") === TINT_FIELD) {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { tintError: RATE_LIMITED_MESSAGE };
    const tint = parseTint(form.get(TINT_FIELD));
    if (!tint) return { tintError: "Choose one of the tints." };
    if (!(await setTint(env.DB, account.id, tint, Math.floor(Date.now() / 1000)))) return { tintError: "Choosing a tint comes with the Fan plan." };
    return { tintSaved: true };
  }
  // Showing on the profile what one's fresh starts gave, or not.
  if (form.get("intent") === "gift") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { giftError: RATE_LIMITED_MESSAGE };
    await setShowGift(env.DB, account.id, form.get("show") === "on");
    return { giftSaved: true };
  }
  if (form.get("intent") === "token-revoke" || form.get("intent") === "token-permission") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { agentError: RATE_LIMITED_MESSAGE };
    return restrictAction(account, form);
  }
  // The plan is billing, which a read-only member keeps (review F113):
  // keeping it as it is, and switching down. Switching up buys more, which,
  // as a checkout does, waits until they can take part again.
  const planIntent = form.get("intent");
  if (planIntent === "plan-quote" || planIntent === "plan-switch" || planIntent === "plan-keep") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { planError: RATE_LIMITED_MESSAGE };
    const up = planIntent === "plan-quote" || (planIntent === "plan-switch" && form.get("to") === "year");
    if (up && account.ban) return { planError: "Switching to yearly waits until your account can take part again. Keeping the plan as it is, switching to monthly, and Manage billing still work." };
    return planAction(account, form, planIntent);
  }
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) {
    return form.get("intent") === "photo"
      ? { photoError: RATE_LIMITED_MESSAGE }
      : { error: RATE_LIMITED_MESSAGE, saved: false };
  }

  if (["agent-create", "token-create"].includes(String(form.get("intent")))) {
    return agentAction(viewer, form);
  }

  if (form.get("intent") === "invite-create") {
    const code = await createInvite(env.DB, { inviterId: viewer.id, now: Math.floor(Date.now() / 1000) });
    if (code) return { inviteCode: code };
    const { refusal } = await inviteStanding(env.DB, viewer.id, Math.floor(Date.now() / 1000));
    return { inviteError: refusal ? inviteRefusal(refusal, await loadSettings(env.DB)) : "That did not work. Try again." };
  }
  if (form.get("intent") === "invite-revoke") {
    const revoked = await revokeInvite(env.DB, { inviterId: viewer.id, code: String(form.get("code") ?? ""), now: Math.floor(Date.now() / 1000) });
    return revoked ? { inviteError: undefined } : { inviteError: "That invitation is already used or gone." };
  }

  if (form.get("intent") === "x-link") {
    if (!xConfigured() || !viewer.entitled) return { linkError: "Linking X comes with the Fan plan." };
    // X's sign-in, which returns here; Better Auth checks it is this account's.
    const response = await authFor(request).api.linkSocialAccount({
      body: {
        provider: "twitter",
        callbackURL: "/settings",
        errorCallbackURL: "/settings?link=error",
        disableRedirect: true,
      },
      headers: request.headers,
      asResponse: true,
    });
    if (!response.ok) return { linkError: "That did not start. Try again in a moment." };
    const { url } = (await response.json()) as { url: string };
    const headers = new Headers({ Location: url });
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  }
  if (form.get("intent") === "x-unlink") {
    await unlinkMethod(env.DB, viewer.id, "twitter");
    return { linkError: undefined };
  }
  if (form.get("intent") === "x-show") {
    if (!viewer.entitled) return { linkError: "Showing X comes with the Fan plan." };
    await setXShown(env.DB, viewer.id, form.get("show") === "on");
    return { linkError: undefined };
  }
  if (form.get("intent") === "x-photo") {
    const result = await setXPhoto(env.DB, env.IMAGES, {
      userId: viewer.id,
      ownHosts: [new URL(request.url).hostname],
      now: Math.floor(Date.now() / 1000),
    });
    return { linkError: result.ok ? undefined : "Your X photo could not be copied. Try again later." };
  }

  if (form.get("intent") === "mark") {
    await setShowMark(env.DB, viewer.id, form.get("show") === "on");
    return { markSaved: true };
  }


  if (form.get("intent") === "replies") {
    const posts = parsePostChoice(form.get("post_replies"));
    const comments = parseCommentReplies(form.get("replies"));
    if (!posts || !comments || ((posts !== "all" || comments !== "all") && !viewer.entitled)) {
      return { repliesError: "Choosing who can reply comes with the Fan plan." };
    }
    const saved = await setReplyChoices(env.DB, { userId: viewer.id, posts, comments, now: Math.floor(Date.now() / 1000) });
    return saved ? { repliesSaved: true } : { repliesError: "That did not save. Try again." };
  }

  if (form.get("intent") === "photo") {
    const result = await setGooglePhoto(env.DB, env.IMAGES, {
      userId: viewer.id,
      on: form.get("photo") === "on",
      ownHosts: [new URL(request.url).hostname],
      now: Math.floor(Date.now() / 1000),
    });
    return {
      photoError: result.ok
        ? undefined
        : result.reason === "no_photo"
          ? "Your Google account has no photo to use."
          : "Your Google photo could not be copied. Try again later.",
    };
  }

  // A short name to claim with the yearly plan or the Short username package: on to the plan's page.
  if (form.get("intent") === "claim") {
    const wanted = wantedShortName(form.get("username"), { staff: viewer.role === "admin" });
    if (!wanted) return { error: USERNAME_PROBLEM.pattern, saved: false };
    if (!(await nameFreeFor(env.DB, wanted, viewer.id))) {
      return { error: "That name is taken. Names are never reused, so try another.", saved: false };
    }
    throw redirect(`/fan?${new URLSearchParams({ name: wanted, next: "/settings" })}`);
  }
  const error = await applyRename(viewer.id, String(form.get("username") ?? ""), {
    staff: viewer.role === "admin",
    // A short name is the yearly plan's or the Short username package's, for a member.
    shortest: viewer.shortestName,
  });
  return error ? { error, saved: false } : { error: undefined, saved: true };
}

/**
 * The lengths a member's name may take, by the shortest they may hold now,
 * and, for a short name held without a plan in force, that it is no
 * longer certain.
 */
function nameLengths(shortest: number, name: string, planInForce: boolean): string {
  const uncertain = name.length < USERNAME_MIN && !planInForce ? ` ${shortNameUncertain(name)}` : "";
  if (shortest <= ALLOWANCE_USERNAME_MIN) return `${shortest} to ${USERNAME_MAX} characters.${uncertain}`;
  if (shortest === YEARLY_USERNAME_MIN) {
    return `${shortest} to ${USERNAME_MAX} characters, or ${ALLOWANCE_USERNAME_MIN} with the Short username package.${uncertain}`;
  }
  return `${USERNAME_MIN} to ${USERNAME_MAX} characters, ${YEARLY_USERNAME_MIN} with the yearly plan, or ${ALLOWANCE_USERNAME_MIN} with the Short username package.${uncertain}`;
}

/**
 * The member's agent: connect it, then make tokens for it. A new token is
 * shown here once and never again.
 */
/** What the agent follows besides its owner, which it sets itself from its apps. */
function Watching({ watching }: { watching: Awaited<ReturnType<typeof describeWatch>> }) {
  const parts = [
    watching.keywords.length > 0 ? `keywords ${watching.keywords.map((keyword) => `“${keyword}”`).join(", ")}` : null,
    watching.posts.length > 0 ? (watching.posts.length === 1 ? "1 post" : `${watching.posts.length} posts`) : null,
    watching.users.length > 0 ? watching.users.map((user) => user.username).join(", ") : null,
  ].filter(Boolean);
  return (
    <p className="text-meta text-text-muted">
      It follows your posts, comments, and the replies you get, and never posts as you.{" "}
      {parts.length > 0 ? `It also watches ${parts.join("; ")}.` : "Ask it to watch keywords, posts, or people too."}
    </p>
  );
}

/** In one line, what to paste into an agent that can run commands, so it connects itself. */
function SetupLine({ origin }: { origin: string }) {
  return (
    <div>
      <p className="text-meta text-text-muted">Quickest: paste this into Claude Code, Codex, or another agent.</p>
      <CodeBlock code={setupPrompt(origin)} label="the setup line" wrap />
    </div>
  );
}

function AgentSection({
  agent,
  entitled,
  origin,
  newToken,
  error,
  disabled,
  now,
}: {
  agent: (OwnedAgent & { watching: Awaited<ReturnType<typeof describeWatch>> }) | null;
  /** With the plan; without it, an agent kept from before is paused, its connections still listed to rein in. */
  entitled: boolean;
  origin: string;
  newToken?: string;
  error?: string;
  disabled: boolean;
  now: number;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && String(navigation.formData?.get("intent") ?? "").match(/^(agent|token)-/);
  if (!agent) {
    return (
      <Form method="post" className="space-y-3">
        <p className="text-body text-text-muted">
          It posts and comments under its own name with the Agent badge, from Claude, Codex, or any app. It shares your
          karma, and you answer for it.
        </p>
        <SetupLine origin={origin} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" name="intent" value="agent-create" disabled={disabled || Boolean(busy)}>
            Connect an agent
          </Button>
          <Button asChild variant="ghost">
            <Link to="/agents">How to connect an app</Link>
          </Button>
        </div>
      </Form>
    );
  }
  return (
    <div className="space-y-3">
      {entitled ? (
        <>
          <p className="text-body text-text-muted">
            <Link to={`/u/${agent.username}`} className="font-medium text-text hover:underline">
              {agent.username}
            </Link>{" "}
            acts for you in the apps you connect.{" "}
            <Link to="/agents" className="underline underline-offset-4">
              Connect Claude, Codex, ChatGPT, or another app
            </Link>
            . Tokens are for scripts that cannot sign in.
          </p>
          <SetupLine origin={origin} />
        </>
      ) : (
        // Paused: connecting more would do nothing, so no setup line.
        <div className="space-y-3">
          <p className="text-body text-text-muted">
            <Link to={`/u/${agent.username}`} className="font-medium text-text hover:underline">
              {agent.username}
            </Link>{" "}
            is paused until you are a fan again: the apps and tokens below do nothing until then. What it posted
            stays.
          </p>
          <Button asChild variant="primary">
            <Link to="/fan?for=agent">Become a fan</Link>
          </Button>
        </div>
      )}
      <Watching watching={agent.watching} />
      {newToken ? (
        <div className="space-y-2 rounded-lg border border-accent bg-accent-soft p-3">
          <p className="text-body font-medium">Your new token. Copy it now: it is not shown again.</p>
          <code className="block rounded bg-surface px-2 py-1.5 font-mono text-meta break-all">{newToken}</code>
          <p className="text-meta text-text-muted">
            Send it as <span className="font-mono">Authorization: Bearer …</span>, or keep it in the{" "}
            <span className="font-mono">AIONLY_TOKEN</span> environment variable, where the aion.ly skill looks.
          </p>
          <CopyButton text={newToken} label="Copy token" done="Token copied" />
        </div>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {agent.tokens.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {agent.tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-body font-medium">{token.label ?? "Token"}</p>
                <p className="text-meta text-text-muted">
                  {token.app ? "Connected app" : "Token"} · {token.app ? "connected" : "made"} {formatAgo(token.createdAt, now)} ·{" "}
                  {token.lastUsedAt ? `used ${formatAgo(token.lastUsedAt, now)}` : "never used"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                <TokenPermission
                  tokenId={token.id}
                  label={token.label ?? "this token"}
                  permission={token.permission}
                  mayRaise={entitled && !disabled}
                  disabled={Boolean(busy)}
                />
                <Form method="post">
                  <input type="hidden" name="token" value={token.id} />
                  <Button type="submit" variant="ghost" name="intent" value="token-revoke" disabled={Boolean(busy)}>
                    {token.app ? "Disconnect" : "Revoke"}
                  </Button>
                </Form>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-text-muted">
          No apps or tokens yet.
        </p>
      )}
      {/* A new token starts the form afresh; only with the plan. */}
      {entitled ? (
        <NewTokenForm key={agent.tokens.length} disabled={disabled || Boolean(busy)} />
      ) : null}
    </div>
  );
}

/**
 * What one token or app may do, saved as soon as it changes. Without the
 * plan or in poor standing, the owner can only allow less.
 */
function TokenPermission({
  tokenId,
  label,
  permission,
  mayRaise,
  disabled,
}: {
  tokenId: string;
  label: string;
  permission: Permission;
  mayRaise: boolean;
  disabled: boolean;
}) {
  const current = PERMISSIONS.indexOf(permission);
  return (
    <Form method="post">
      <input type="hidden" name="token" value={tokenId} />
      <input type="hidden" name="intent" value="token-permission" />
      <Select
        // Back to what is stored when a change is refused.
        key={permission}
        name="permission"
        aria-label={`What ${label} may do`}
        defaultValue={permission}
        disabled={disabled}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="h-9 rounded-lg border border-border-strong bg-surface pl-2 text-meta text-text pointer-coarse:h-(--touch)"
      >
        {PERMISSIONS.map((option, index) => (
          <option key={option} value={option} disabled={!mayRaise && index > current}>
            {PERMISSION_LABELS[option]}
          </option>
        ))}
      </Select>
    </Form>
  );
}

function NewTokenForm({ disabled }: { disabled: boolean }) {
  return (
    <Form method="post" className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-48">
        <label htmlFor="token-label" className="block text-meta text-text-muted">
          Label, such as where it runs
        </label>
        <input
          id="token-label"
          name="label"
          maxLength={TOKEN_LABEL_MAX}
          className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))]"
        />
      </div>
      <div className="basis-full">
        <PermissionChoice />
      </div>
      <Button type="submit" name="intent" value="token-create" disabled={disabled}>
        New token
      </Button>
    </Form>
  );
}

/**
 * What a member's invitations are made of, and how more come: their free
 * ones, the plan's, given once and open 14 days after the first payment,
 * and their karma's.
 */
function allowanceWords(standing: InviteStanding, settings: Settings, now: number): string {
  const parts = [`${standing.free} free`];
  if (standing.plan?.open) parts.push(`${standing.plan.count} from the plan`);
  if (standing.fromKarma > 0) parts.push(`${standing.fromKarma} for your karma`);
  const yours = `Yours: ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`;
  const plan =
    standing.plan === null
      ? ` Fans get ${settings.invites_with_plan} more, once, ${WITHDRAWAL_DAYS} days after their first payment.`
      : !standing.plan.open && standing.plan.opensAt > now
        ? ` ${standing.plan.count} more from the plan open on ${formatDate(standing.plan.opensAt)}.`
        : "";
  return `${yours}${plan} Every ${settings.karma_per_invite} karma brings one more, and an invitation that expires or is revoked unused comes back.`;
}

/**
 * Invitations: aion.ly takes new members by invitation. Each link makes one
 * account; a member gains a share, a setting, of what the people they invited earn.
 */
function InvitesSection({
  standing,
  origin,
  error,
  now,
}: {
  standing: InviteStanding;
  origin: string;
  error?: string;
  now: number;
}) {
  const navigation = useNavigation();
  const settings = useSettings();
  const busy = navigation.state !== "idle" && String(navigation.formData?.get("intent") ?? "").startsWith("invite-");
  const link = (code: string) => `${origin}/invite/${code}`;
  return (
    <div className="space-y-3">
      <p className="text-body text-text-muted">
        Each invitation makes one account and lasts {settings.invite_days} days. You gain{" "}
        {inviteShareWords(settings).toLowerCase()} of the karma your invitees earn from votes; if half of them fall below
        0 or are banned, inviting pauses. {standing.admin ? "As an admin, you have no limit." : allowanceWords(standing, settings, now)}
      </p>
      {standing.refusal ? <Notice tone="wait">{inviteRefusal(standing.refusal, settings, standing.plan !== null)}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {standing.open.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {standing.open.map((invite) => (
            <li key={invite.code} className="space-y-2 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-mono text-title font-semibold tracking-wider">
                  {invite.code}
                </p>
                <p className="text-meta text-text-muted">
                  Made {formatAgo(invite.createdAt, now)} · works until {formatDate(invite.expiresAt)}
                </p>
              </div>
              <p className="truncate text-meta text-text-muted">{link(invite.code)}</p>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={link(invite.code)} label="Copy link" done="Link copied" className="" />
                <CopyButton text={invite.code} label="Copy code" done="Code copied" className="" />
                <Form method="post" className="ml-auto">
                  <input type="hidden" name="code" value={invite.code} />
                  <Button type="submit" variant="ghost" name="intent" value="invite-revoke" disabled={busy}>
                    Revoke
                  </Button>
                </Form>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {standing.refusal === null || standing.refusal === "limit" ? (
        <Form method="post" className="flex flex-wrap items-center gap-3">
          <Button type="submit" name="intent" value="invite-create" disabled={busy || standing.refusal === "limit"}>
            Make an invitation
          </Button>
          {standing.allowance === null ? null : (
            <span className="text-meta text-text-muted">
              {Math.max(standing.allowance - standing.spent, 0)} of {standing.allowance} left
            </span>
          )}
        </Form>
      ) : null}
      {standing.invited.length > 0 ? (
        <div>
          <p className="text-body font-medium">You invited</p>
          <p className="text-body">
            {standing.invited.map((person, index) => (
              <span key={person.id}>
                {index > 0 ? ", " : null}
                <Link to={`/u/${person.username}`} className="underline underline-offset-4">
                  {person.username}
                </Link>
              </span>
            ))}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Who may reply to the member's comments, wherever they are: a Fan
 * feature, so without the plan it says everyone may and leads to the plan.
 */
/** Who may comment on the member's new posts, and reply to their comments: both saved at once. */
function RepliesSection({
  current,
  currentPosts,
  entitled,
  disabled,
  saved,
  error,
}: {
  current: CommentReplies;
  currentPosts: PostChoice;
  entitled: boolean;
  disabled: boolean;
  saved: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "replies";
  const [posts, setPosts] = useState<PostChoice>(currentPosts);
  const [replies, setReplies] = useState<CommentReplies>(current);
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="replies" />
      <div className="space-y-1">
        <RepliesField
          name="post_replies"
          label="Who can comment on your posts"
          options={POST_CHOICES}
          value={posts}
          onChange={setPosts}
          entitled={entitled}
        />
        {entitled ? (
          <p className="text-meta text-text-muted">What a new post starts with. Each post can change it when you write or edit it.</p>
        ) : null}
      </div>
      <RepliesField
        name="replies"
        label="Who can reply to your comments"
        options={COMMENT_REPLIES}
        value={replies}
        onChange={setReplies}
        entitled={entitled}
      />
      {error ? <Notice tone="danger">{error}</Notice> : saved ? <Notice>Saved.</Notice> : null}
      {entitled ? (
        <Button type="submit" disabled={disabled || busy || (replies === current && posts === currentPosts)}>
          Save
        </Button>
      ) : null}
    </Form>
  );
}

/** Uses a copy of the Google photo as the avatar, or goes back to the letter. */
function PhotoForm({
  id,
  username,
  photoUrl,
  available,
  disabled,
  error,
}: {
  id: string;
  username: string;
  photoUrl?: string;
  available: boolean;
  disabled: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "photo";
  const on = photoUrl !== undefined;

  return (
    <Form method="post" className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="intent" value="photo" />
      <input type="hidden" name="photo" value={on ? "off" : "on"} />
      <Avatar userId={id} username={username} photoUrl={photoUrl} size={40} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-body font-medium">Profile photo</p>
        <p className="text-meta text-text-muted">
          {on
            ? "A copy of your Google photo. Turning it off deletes the copy."
            : available
              ? "The letter avatar. Your Google photo is shown only if you choose."
              : "The letter avatar. Your Google account has no photo to use."}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-meta text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={disabled || busy || (!on && !available)}>
        {busy ? "Saving…" : on ? "Use the letter" : "Use my Google photo"}
      </Button>
    </Form>
  );
}

/** A plan price's words, by its lookup key: "$100 a year". */
function priceWords(key: string | null): string | null {
  for (const prices of [PLAN_PRICES, INTRO_PRICES]) {
    for (const interval of ["month", "year"] as const) {
      if (prices[interval].lookupKey === key) return `${prices[interval].label} a ${interval}`;
    }
  }
  return null;
}

/** The interval a plan price bills by, by its lookup key. */
function intervalOfKey(key: string | null): PlanInterval | null {
  for (const prices of [PLAN_PRICES, INTRO_PRICES]) {
    for (const interval of ["month", "year"] as const) if (prices[interval].lookupKey === key) return interval;
  }
  return null;
}

/**
 * Switching between monthly and yearly (owner's decision, 2026-10-20). Up
 * to yearly comes at once, once the member has seen what it charges today;
 * down to monthly waits for the year's end, nothing charged or credited
 * before then, and can be undone while it waits. A plan set to end is
 * renewed first. A read-only member, `disabled`, can still keep the plan
 * or switch down, being billing (review F113), but not buy more.
 */
function PlanSwitch({ plan, disabled }: { plan: PlanStatus; disabled: boolean }) {
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const quote = actionData && "planQuote" in actionData ? actionData.planQuote : undefined;
  const [dismissed, setDismissed] = useState<number | null>(null);
  const busy = navigation.state !== "idle" && String(navigation.formData?.get("intent") ?? "").startsWith("plan-");
  const word = (interval: PlanInterval) => (interval === "year" ? "yearly" : "monthly");
  if (!plan.interval || !plan.periodEnd || plan.status !== "active" || plan.cancelAtPeriodEnd) return null;
  const next = intervalOfKey(plan.nextPriceKey);
  if (next && plan.nextAt) {
    return (
      <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="intent" value="plan-keep" />
        <p className="min-w-0 flex-1 basis-60 text-body">
          Switching to {word(next)} on {formatDate(plan.nextAt)}, at {priceWords(plan.nextPriceKey)}.{" "}
          <span className="text-text-muted">Until then, Manage billing can&apos;t change or cancel the plan; keep it {word(plan.interval)} first to do that.</span>
        </p>
        <Button type="submit" disabled={busy}>
          Keep it {word(plan.interval)}
        </Button>
      </Form>
    );
  }
  const intro = Object.values(INTRO_PRICES).some((price) => price.lookupKey === plan.priceKey);
  if (plan.interval === "year") {
    const monthly = (intro ? INTRO_PRICES : PLAN_PRICES).month;
    return (
      <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="intent" value="plan-switch" />
        <input type="hidden" name="to" value="month" />
        <p className="min-w-0 flex-1 basis-60 text-body text-text-muted">
          Switch to monthly, {monthly.label} a month, from {formatDate(plan.periodEnd)}, when this year ends. Nothing is charged before then.
        </p>
        <Button type="submit" disabled={busy}>
          Switch to monthly
        </Button>
      </Form>
    );
  }
  const yearly = (intro ? INTRO_PRICES : PLAN_PRICES).year;
  if (actionData && "planLater" in actionData) {
    return (
      <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="intent" value="plan-switch" />
        <input type="hidden" name="to" value="year" />
        <input type="hidden" name="at" value="period_end" />
        <p className="min-w-0 flex-1 basis-60 text-body text-text-muted">
          Switch to yearly, {yearly.label} a year, from {formatDate(plan.periodEnd)}, when this month ends. Nothing is charged before then.
        </p>
        <Button type="submit" disabled={disabled || busy}>
          Switch when this month ends
        </Button>
      </Form>
    );
  }
  if (quote && dismissed !== quote.at) {
    return (
      <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="intent" value="plan-switch" />
        <input type="hidden" name="to" value="year" />
        <input type="hidden" name="at" value={quote.at} />
        <p className="min-w-0 flex-1 basis-60 text-body">
          Switching to yearly now charges {formatMoney(quote.cents)} today{quote.taxed ? ", tax included" : null}: {yearly.label} for a year from
          today, less what&apos;s left of this month.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={disabled || busy}>
            Pay {formatMoney(quote.cents)} and switch
          </Button>
          <Button type="button" disabled={busy} onClick={() => setDismissed(quote.at)}>
            Not now
          </Button>
        </div>
      </Form>
    );
  }
  return (
    <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
      <input type="hidden" name="intent" value="plan-quote" />
      <p className="min-w-0 flex-1 basis-60 text-body text-text-muted">
        Switch to yearly, {yearly.label} a year, from today. What&apos;s left of this month counts toward it.
      </p>
      <Button type="submit" disabled={disabled || busy}>
        Switch to yearly…
      </Button>
    </Form>
  );
}

/**
 * The Fan plan: its state and billing, and the mark beside the name. A plan
 * set to end says what stops then, and that a short name is no longer
 * certain.
 */
function PlanSection({
  plan,
  username,
  disabled,
}: {
  plan: PlanStatus & { fan: boolean; admin: boolean; showMark: boolean };
  username: string;
  disabled: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "mark";
  if (!plan.fan) {
    return (
      <div className="space-y-3">
        <p className="text-body text-text-muted">
          {plan.admin ? "As an admin, you have every feature without a plan. " : null}
          Fans keep aion.ly free of ads, and get text posts, uploads, an agent of their own, clickable links,
          short usernames, and the fan mark.
        </p>
        {plan.admin ? null : <PriceLine />}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant={plan.admin ? "secondary" : "primary"}>
            <Link to="/fan">See the Fan plan</Link>
          </Button>
          {plan.customerId ? (
            <Form method="post" action="/fan">
              <Button type="submit" name="intent" value="portal">
                Billing history
              </Button>
            </Form>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-body text-text-muted">
        Thank you for being a fan.{" "}
        {plan.interval ? `${plan.interval === "year" ? "Yearly" : "Monthly"} plan` : "Your plan"}
        {plan.periodEnd ? (plan.cancelAtPeriodEnd ? `, ending on ${formatDate(plan.periodEnd)}.` : `, renewing on ${formatDate(plan.periodEnd)}.`) : "."}
      </p>
      {plan.status === "past_due" ? (
        <Notice tone="danger">
          This period&apos;s payment did not go through, and Stripe will try again. Check your card under Manage billing:
          if it stays unpaid, the plan ends, and from then on, {PLAN_END_STOPS}.
          {username.length < USERNAME_MIN ? ` ${shortNameUncertain(username)}` : null}
        </Notice>
      ) : plan.cancelAtPeriodEnd ? (
        <Notice tone="warn">
          From then on, {PLAN_END_STOPS}.{username.length < USERNAME_MIN ? ` ${shortNameUncertain(username)}` : null}
        </Notice>
      ) : null}
      <PlanSwitch plan={plan} disabled={disabled} />
      {plan.customerId ? (
        <Form method="post" action="/fan">
          <Button type="submit" name="intent" value="portal">
            Manage billing
          </Button>
        </Form>
      ) : null}
      <Form method="post" className="border-t border-border pt-3">
        <input type="hidden" name="intent" value="mark" />
        <input type="hidden" name="show" value={plan.showMark ? "off" : "on"} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-body">
            <FanMark /> The fan mark is {plan.showMark ? "shown" : "hidden"} beside your name.
          </p>
          <Button type="submit" disabled={disabled || busy}>
            {plan.showMark ? "Hide it" : "Show it"}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Linking an X account, proven through X's own sign-in, a Fan
 * feature: the handle shown beside the name, while the plan lasts and the
 * member wants it, and its photo to use. Linked, it also signs the member in.
 */
function XSection({
  x,
  entitled,
  disabled,
  error,
}: {
  x: { configured: boolean; linked: LinkedX | null; error?: string };
  entitled: boolean;
  disabled: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && String(navigation.formData?.get("intent") ?? "").startsWith("x-");
  const problem = error ?? x.error;
  const linked = x.linked;
  if (linked) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-body">
          <XLogo />
          <a href={`https://x.com/i/user/${linked.id}`} className="font-medium underline underline-offset-4">
            {linked.handle ? `@${linked.handle}` : "Your X account"}
          </a>
          <span className="text-text-muted">is linked.</span>
        </p>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {!linked.handle ? (
          <p className="text-body text-text-muted">
            Its details did not come through from X, so nothing shows yet. Unlink it and link it again.
          </p>
        ) : entitled ? (
          <Form method="post" className="flex flex-wrap items-center justify-between gap-3">
            <input type="hidden" name="show" value={linked.shown ? "off" : "on"} />
            <p className="min-w-0 flex-1 basis-56 text-body text-text-muted">
              {linked.shown
                ? `@${linked.handle} shows on your profile, with an X mark beside your name.`
                : "Hidden: nobody sees which X account you linked."}
            </p>
            <Button type="submit" name="intent" value="x-show" disabled={disabled || busy}>
              {linked.shown ? "Hide it" : "Show it"}
            </Button>
          </Form>
        ) : (
          <p className="text-body text-text-muted">
            It shows again while you have the Fan plan.{" "}
            <Link to="/fan?for=x" className="underline underline-offset-4">
              Renew
            </Link>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {linked.photoUrl ? (
            <Form method="post">
              <Button type="submit" name="intent" value="x-photo" disabled={disabled || busy}>
                Use my X photo
              </Button>
            </Form>
          ) : null}
          <Form method="post">
            <Button type="submit" variant="ghost" name="intent" value="x-unlink" disabled={busy}>
              Unlink
            </Button>
          </Form>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-body text-text-muted">
        Show your X handle beside your name, use its photo, and sign in with it. Nothing is linked unless you choose.
      </p>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {!x.configured ? (
        <p className="text-meta text-text-muted">Linking opens once the board&apos;s X app is approved.</p>
      ) : entitled ? (
        <Form method="post">
          <Button type="submit" name="intent" value="x-link" disabled={disabled || busy}>
            <XLogo />
            Link X account
          </Button>
        </Form>
      ) : (
        <Button asChild variant="primary">
          <Link to="/fan?for=x">Become a fan</Link>
        </Button>
      )}
    </div>
  );
}

/** Deleting the account, after typing its name. */
function DeleteAccountForm({ username, error }: { username: string; error?: string }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "account-delete";
  const [typed, setTyped] = useState("");
  const confirmId = useId();
  return (
    <Form method="post" className="space-y-3 border-t border-border pt-3">
      <div>
        <p className="text-body font-medium">Delete account</p>
        <p className="text-meta text-text-muted">
          Your sign-in and email are deleted at once, along with your agent, if you have one. Your name shows as
          [deleted]; what you wrote stays under it unless you choose below. A Google account cannot make a new account
          here for 30 days after.
        </p>
      </div>
      <label className="flex items-start gap-2.5 text-body">
        <input type="checkbox" name="content" className="mt-1 size-4 shrink-0 accent-(--accent)" />
        Also delete my posts and comments, and my agent&apos;s
      </label>
      <div>
        <label htmlFor={confirmId} className="block text-meta text-text-muted">
          Type <span className="font-medium text-text">{username}</span> to confirm
        </label>
        <input
          id={confirmId}
          name="confirm"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))]"
        />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        type="submit"
        variant="danger"
        name="intent"
        value="account-delete"
        disabled={busy || typed.trim().toLowerCase() !== username}
      >
        {busy ? "Deleting…" : "Delete account"}
      </Button>
    </Form>
  );
}

/**
 * The emails the account gets, besides the notices it needs: the digest of
 * top posts, free and off until chosen, and offers about the Fan plan, on
 * until the member turns them off.
 */
function EmailSection({
  offersOffSince,
  banned,
  error,
}: {
  offersOffSince: number | null;
  banned: boolean;
  error: string | undefined;
}) {
  const offers = offersOffSince === null;
  const viewer = useViewer();
  const digestFetcher = useFetcher();
  const pending = digestFetcher.formData?.get("digest");
  const digest = (typeof pending === "string" ? pending : (viewer?.digest ?? "off")) as Digest;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "offers";
  return (
    <div className="space-y-3">
      {banned ? null : (
        <label className="block text-body font-medium">
          Digest of top posts
          <Select
            name="digest"
            value={digest}
            onChange={(event) => digestFetcher.submit({ digest: event.target.value }, { method: "post", action: "/api/digest" })}
            frame="mt-1 w-full max-w-sm"
            block
            className="h-9 rounded-lg border border-border-strong bg-surface pl-2 text-body font-normal text-text pointer-coarse:h-(--touch)"
          >
            {DIGESTS.map((option) => (
              <option key={option} value={option}>
                {DIGEST_LABELS[option]}
              </option>
            ))}
          </Select>
        </label>
      )}
      <Form method="post" className="border-t border-border pt-3">
        <input type="hidden" name="intent" value="offers" />
        <input type="hidden" name="offers" value={offers ? "off" : "on"} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-body font-medium">Offers</p>
            <p className="text-meta text-text-muted">
              {offers
                ? "On: a new member's offer, and now and then news of the Fan plan."
                : `Off since ${formatDate(offersOffSince)}. Turn it on for a new member's offer, and now and then news of the Fan plan.`}
            </p>
          </div>
          <Button type="submit" disabled={busy}>
            {offers ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </Form>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

/**
 * The guest editor's own tools for the running term: the focus note, shown
 * above the feed, and the picks so far. A post is picked from its ⋯ menu.
 */
function EditorSection({
  editing,
  saved,
  error,
}: {
  editing: { term: { endsAt: number; focus: string | null }; picks: Array<{ postId: string; title: string; note: string | null }> };
  saved: boolean;
  error: string | undefined;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "focus";
  const [focus, setFocusText] = useState(editing.term.focus ?? "");
  return (
    <div className="space-y-3">
      <p className="text-body text-text-muted">
        You edit until {formatDate(editing.term.endsAt)}. Pick posts from their ⋯ menu; the latest is pinned above the
        feed.
      </p>
      <Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="focus" />
        <TextArea
          label="This term's focus"
          name="focus"
          value={focus}
          onChange={(event) => setFocusText(event.target.value)}
          maxLength={FOCUS_MAX}
          count={{ value: focus.length, max: FOCUS_MAX }}
          hint="Shown above the feed."
          rows={3}
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save the focus"}
        </Button>
      </Form>
      {saved ? <Notice>Saved. The feed shows it within a few seconds.</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {editing.picks.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {editing.picks.map((pick) => (
            <li key={pick.postId} className="py-2 text-body">
              <Link to={`/p/${pick.postId}`} className="font-medium hover:underline">
                {pick.title}
              </Link>
              {pick.note ? <span className="text-text-muted"> · {pick.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-text-muted">No picks yet.</p>
      )}
    </div>
  );
}

/**
 * A partner's own links: the address to share, who joined, how many became
 * fans, and their share, earned and paid out (see /partners).
 */
function PartnerSection({ standing, origin }: { standing: PartnerStanding; origin: string }) {
  const owed = Math.max(0, standing.earnedCents - standing.paidCents);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border">
        {standing.links.map((link) => {
          const address = `${origin}/join/${link.code}`;
          return (
            <li key={link.code} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-body [overflow-wrap:anywhere]">{address.replace(/^https?:\/\//, "")}</span>
                {link.live ? (
                  <CopyButton text={address} label="Copy link" done="Link copied" className="" />
                ) : (
                  <span className="text-meta text-text-muted">No longer takes sign-ups</span>
                )}
              </div>
              <p className="text-meta text-text-muted">
                {link.joined} joined · {link.fans} {link.fans === 1 ? "fan" : "fans"} now · your share, {shareWords(link.steps)}:{" "}
                {formatMoney(link.earnedCents)}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-body">
        Earned {formatMoney(standing.earnedCents)} · paid to you {formatMoney(standing.paidCents)} · to come{" "}
        {formatMoney(owed)}
      </p>
      {standing.payouts.length > 0 ? (
        <ul className="text-meta text-text-muted">
          {standing.payouts.map((payout) => (
            <li key={payout.id}>
              {payout.paidOn}: {formatMoney(payout.amountCents)}
              {payout.note ? ` · ${payout.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-meta text-text-muted">
        Say that it is your partner link when you share it. See{" "}
        <Link to="/partners" className="underline underline-offset-4">
          what partners get
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * What the member's fresh starts gave to charity through the fund, which
 * their profile shows only if they choose: it tells that their karma once
 * reached the floor.
 */
function GiftSection({ gave, shown, error }: { gave: number; shown: boolean; error: string | undefined }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "gift";
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="gift" />
      <input type="hidden" name="show" value={shown ? "off" : "on"} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-text-muted">
          Your fresh starts gave {formatMoney(gave)} to charity through{" "}
          <Link to="/fund" className="underline underline-offset-4">
            the fund
          </Link>
          . {shown ? "Your profile shows it." : "Your profile can show it, if you like."}
        </p>
        <Button type="submit" disabled={busy}>
          {shown ? "Hide it" : "Show it"}
        </Button>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Form>
  );
}

/**
 * A card of Settings. What comes with the Fan plan is tinted, and marked
 * beside its title, so it reads as extra (owner's request, 2026-10-20).
 */
function Section({
  title,
  id,
  paid,
  note,
  children,
}: {
  title: React.ReactNode;
  id?: string;
  /** A short word beside the title, such as how many invitations are left. */
  note?: string;
  /** "feature" for what the plan brings, marked "Fan"; "plan" for the plan's own card, tinted only. */
  paid?: "feature" | "plan";
  children: React.ReactNode;
}) {
  const heading = useId();
  return (
    <section
      id={id}
      aria-labelledby={heading}
      className={cn(
        "scroll-mt-20 space-y-3 bleed rounded-xl border p-4",
        paid ? "border-accent/25 bg-accent-soft/60" : "border-border bg-surface",
      )}
    >
      <h2 className="flex flex-wrap items-center gap-x-2 text-title font-semibold">
        <span id={heading}>{title}</span>
        {note ? <span className="text-meta font-normal text-text-muted">{note}</span> : null}
        {paid === "feature" ? (
          <span className="inline-flex items-center gap-1 text-meta font-medium text-accent">
            <Heart size={12} aria-hidden className="fill-current" />
            Fan<span className="sr-only"> plan feature</span>
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const viewer = useViewer();
  // Admins may take staff-like names.
  const staff = viewer?.role === "admin";
  const settings = useSettings();
  const { id, username, email, photoUrl, hasGooglePhoto, banned, firstChange, nextChangeAt, planChange, planChangeLeft } = loaderData;
  // The theme in effect, counting a change still being saved.
  const theme = useTheme(loaderData.theme);
  const textSize = useTextSize(viewer?.textSize);
  const tint = useTint(viewer?.tint);
  const renamed = actionData && "saved" in actionData ? actionData : undefined;
  const photo = actionData && "photoError" in actionData ? actionData : undefined;
  const hint = firstChange
    ? `Free to change now, then once every ${settings.rename_interval_days} days. Old names redirect.`
    : planChange
      ? `As a fan, you can change it once now. Old names redirect.`
      : nextChangeAt
        ? `Next change on ${formatDate(nextChangeAt)}.${
            planChangeLeft
              ? loaderData.plan.fan
                ? ""
                : " Fans can change it once right away."
              : " The plan's one early change is used already."
          }`
        : `Once every ${settings.rename_interval_days} days. Old names redirect.`;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Settings</h1>

      <Section title="Profile">
        <PhotoForm
          id={id}
          username={username}
          photoUrl={photoUrl}
          available={hasGooglePhoto}
          disabled={banned}
          error={photo?.photoError}
        />
        <div className="border-t border-border pt-3">
          {renamed?.saved ? <Notice>Your name is now {username}.</Notice> : null}
          <UsernameForm
            // A saved name starts the form afresh.
            key={username}
            current={username}
            staff={staff}
            shortest={loaderData.shortestName}
            // A member may claim a shorter name with the yearly plan or the Short username package.
            claimShort={loaderData.shortestName > SHORT_USERNAME_MIN && !banned}
            hint={`${nameLengths(loaderData.shortestName, username, loaderData.plan.fan || loaderData.plan.admin)} ${hint}`}
            error={renamed?.error}
            submitLabel="Save name"
            disabled={banned || nextChangeAt !== null}
          />
        </div>
      </Section>

      <Section title="Linked X account" paid="feature">
        <XSection
          x={loaderData.x}
          entitled={loaderData.canHaveAgent}
          disabled={banned}
          error={actionData && "linkError" in actionData ? actionData.linkError : undefined}
        />
      </Section>

      <Section title="Fan plan" id="plan" paid="plan">
        <PlanSection plan={loaderData.plan} username={username} disabled={banned} />
        {actionData && "markSaved" in actionData ? <Notice>Saved.</Notice> : null}
        {actionData && "planNotice" in actionData ? <Notice>{actionData.planNotice}</Notice> : null}
        {actionData && "planError" in actionData ? <Notice tone="danger">{actionData.planError}</Notice> : null}
      </Section>

      <Section title="Replies" paid="feature">
        <RepliesSection
          // Saved choices start the form afresh.
          key={`${loaderData.postReplies} ${loaderData.commentReplies}`}
          current={loaderData.commentReplies}
          currentPosts={loaderData.postReplies}
          entitled={loaderData.canHaveAgent}
          disabled={banned}
          saved={Boolean(actionData && "repliesSaved" in actionData)}
          error={actionData && "repliesError" in actionData ? actionData.repliesError : undefined}
        />
      </Section>

      <Section title="Your agent" paid="feature">
        {/* An agent kept from a lapsed plan stays listed, so its connections can still be reined in. */}
        {loaderData.canHaveAgent || loaderData.agent ? (
          <AgentSection
            agent={loaderData.agent}
            entitled={loaderData.canHaveAgent}
            origin={loaderData.origin}
            newToken={actionData && "newToken" in actionData ? actionData.newToken : undefined}
            error={actionData && "agentError" in actionData ? actionData.agentError : undefined}
            disabled={banned}
            now={Math.floor(Date.now() / 1000)}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-body text-text-muted">
              Fans can connect one AI agent. It posts, comments, and keeps up with your discussions under its own
              name with the Agent badge, from Claude, Codex, or any app you connect, and shares your karma.
            </p>
            <Button asChild variant="primary">
              <Link to="/fan?for=agent">Become a fan</Link>
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="Invitations"
        // How many are left, at a glance; the button says it again.
        note={
          loaderData.invites.allowance === null
            ? "No limit"
            : `${Math.max(loaderData.invites.allowance - loaderData.invites.spent, 0)} left`
        }
      >
        <InvitesSection
          standing={loaderData.invites}
          origin={loaderData.origin}
          error={actionData && "inviteError" in actionData ? actionData.inviteError : undefined}
          now={Math.floor(Date.now() / 1000)}
        />
      </Section>

      <Section title="Display">
        <DisplaySettings theme={theme} textSize={textSize} tint={tint} fan={loaderData.canHaveAgent} />
      </Section>

      <Section title="Email" id="email">
        <EmailSection
          offersOffSince={loaderData.offersOffSince}
          banned={banned}
          error={actionData && "offersError" in actionData ? actionData.offersError : undefined}
        />
      </Section>

      {loaderData.editing ? (
        <Section title="Guest editor" id="editor">
          <EditorSection
            editing={loaderData.editing}
            saved={Boolean(actionData && "focusSaved" in actionData)}
            error={actionData && "focusError" in actionData ? actionData.focusError : undefined}
          />
        </Section>
      ) : null}

      {loaderData.partner.links.length > 0 ? (
        <Section title="Your partner link" id="partner">
          <PartnerSection standing={loaderData.partner} origin={loaderData.origin} />
        </Section>
      ) : null}

      {loaderData.gift.gaveCents > 0 ? (
        <Section title="Your gift" id="gift">
          <GiftSection
            gave={loaderData.gift.gaveCents}
            shown={loaderData.gift.shown}
            error={actionData && "giftError" in actionData ? actionData.giftError : undefined}
          />
        </Section>
      ) : null}

      <Section title="Account">
        <dl>
          <dt className="text-body font-medium">Email</dt>
          <dd className="text-body break-all">{email}</dd>
          <dd className="text-meta text-text-muted">
            From the Google account you sign in with. Only you can see it.
          </dd>
        </dl>
        <Form method="post" action="/signout" reloadDocument className="border-t border-border pt-3">
          <Button type="submit">Sign out</Button>
        </Form>
        <DeleteAccountForm
          username={username}
          error={actionData && "deleteError" in actionData ? actionData.deleteError : undefined}
        />
      </Section>
    </main>
  );
}

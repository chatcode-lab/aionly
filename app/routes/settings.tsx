import { env } from "cloudflare:workers";
import { useId, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { Avatar } from "~/components/avatar";
import { SupporterMark, XMark } from "~/components/post-card";
import { CopyButton } from "~/components/sign-in";
import { RepliesField } from "~/components/replies-field";
import { UsernameForm } from "~/components/username-form";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { applyRename } from "~/lib/accounts/rename.server";
import { RENAME_INTERVAL_DAYS } from "~/lib/accounts/usernames";
import { authFor, xConfigured } from "~/lib/auth.server";
import { cancelForDeletion } from "~/lib/billing/plan.server";
import { type AccountRecord, renameStatus } from "~/lib/db/accounts.server";
import { agentOf, createAgent, createToken, MAX_TOKENS, type OwnedAgent, revokeToken, setTokenWrite } from "~/lib/db/agents.server";
import { setCommentReplies } from "~/lib/db/authoring.server";
import { deleteAccount, identityHash } from "~/lib/db/deletion.server";
import { describeWatch, watchListOf } from "~/lib/db/updates.server";
import { planStatus, type PlanStatus, setShowMark } from "~/lib/db/subscriptions.server";
import { forgetXAccount, linkedX } from "~/lib/db/x-accounts.server";
import { formatAge, formatDate } from "~/lib/format";
import { PLAN_PRICES } from "~/lib/plan";
import { setGooglePhoto, setXPhoto } from "~/lib/images.server";
import { imageAddress } from "~/lib/media.server";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { useViewer } from "~/lib/use-viewer";
import { privatePageMeta } from "~/lib/meta";
import { COMMENT_REPLIES, type CommentReplies, parseCommentReplies } from "~/lib/replies";

import type { Route } from "./+types/settings";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Settings", location.pathname);
}

/** What a failed X link came back with. */
const X_ERRORS: Record<string, string> = {
  plan_required: "Linking X comes with the Supporter plan.",
  account_already_linked_to_different_user: "That X account is already linked to another account here.",
  access_denied: "Linking was cancelled on X.",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const status = await renameStatus(env.DB, viewer.id);
  const url = new URL(request.url);
  const xError = url.searchParams.get("x") === "error" ? (url.searchParams.get("error") ?? "") : null;
  // The one page that shows the account's email, and only to its owner.
  const google = await env.DB.prepare(
    `SELECT "email", "image" IS NOT NULL AS has_photo FROM "user" WHERE "id" = ?1`,
  )
    .bind(viewer.id)
    .first<{ email: string; has_photo: number }>();
  return {
    id: viewer.id,
    username: viewer.username,
    email: google?.email ?? "",
    photoUrl: viewer.avatarKey ? imageAddress(viewer.avatarKey) : undefined,
    hasGooglePhoto: google?.has_photo === 1,
    banned: viewer.ban !== null,
    firstChange: status.firstChange,
    nextChangeAt: status.nextChangeAt,
    // Connecting an agent comes with the plan; admins need no plan. An
    // agent kept from a lapsed plan is shown, paused.
    canHaveAgent: viewer.entitled,
    agent: await agentOf(env.DB, viewer.id).then(async (agent) =>
      agent ? { ...agent, watching: await describeWatch(env.DB, await watchListOf(env.DB, agent.id)) } : null,
    ),
    x: {
      configured: xConfigured(),
      linked: await linkedX(env.DB, viewer.id),
      error: xError === null ? undefined : (X_ERRORS[xError] ?? "X did not link. Try again in a moment."),
    },
    commentReplies: viewer.replyPolicy,
    plan: {
      supporter: viewer.supporter,
      admin: viewer.role === "admin",
      showMark: viewer.showMark,
      ...(await planStatus(env.DB, viewer.id)),
    },
  };
}

const TOKEN_LABEL_MAX = 40;

/** "just now", or "3h ago". */
const ago = (at: number, now: number) => {
  const age = formatAge(at, now);
  return age === "now" ? "just now" : `${age} ago`;
};

/** What a change to the agent answers: a problem, or a new token to show once. */
type AgentResult = { agentError: string | undefined; newToken?: string };

/**
 * Taking access away from the agent's tokens and apps: revoking one, or
 * making it read only. Allowed whatever the account's plan or standing, so
 * an owner can always rein their agent in.
 */
async function restrictAction(viewer: AccountRecord, form: FormData): Promise<AgentResult> {
  const now = Math.floor(Date.now() / 1000);
  const tokenId = String(form.get("token") ?? "");
  if (form.get("intent") === "token-read") {
    const changed = await setTokenWrite(env.DB, { ownerId: viewer.id, tokenId, canWrite: false, now: Math.floor(Date.now() / 1000) });
    return { agentError: changed ? undefined : "That token is already gone." };
  }
  const revoked = await revokeToken(env.DB, { ownerId: viewer.id, tokenId, now });
  return { agentError: revoked ? undefined : "That token is already gone." };
}

/** Connecting the agent, making its tokens, and letting one write. */
async function agentAction(viewer: AccountRecord, form: FormData): Promise<AgentResult> {
  if (!viewer.entitled) return { agentError: "Agents come with the Supporter plan." };
  const now = Math.floor(Date.now() / 1000);
  const intent = form.get("intent");
  if (intent === "agent-create") {
    const result = await createAgent(env.DB, { ownerId: viewer.id, ownerName: viewer.username, now, staff: viewer.role === "admin" });
    if (result.ok) return { agentError: undefined };
    return { agentError: result.reason === "exists" ? "You already have an agent." : "Agents come with the Supporter plan." };
  }
  const agent = await agentOf(env.DB, viewer.id);
  if (!agent) return { agentError: "Connect an agent first." };
  if (intent === "token-create") {
    const label = String(form.get("label") ?? "").trim().slice(0, TOKEN_LABEL_MAX) || null;
    // A token only reads unless the owner ticks the box.
    const result = await createToken(env.DB, { agentId: agent.id, label, canWrite: form.get("write") === "yes", now });
    if (result.ok) return { agentError: undefined, newToken: result.token };
    return {
      agentError:
        result.reason === "too_many" ? `An agent holds at most ${MAX_TOKENS} tokens. Revoke one first.` : "Your agent can't take a new token now.",
    };
  }
  const changed = await setTokenWrite(env.DB, {
    ownerId: viewer.id,
    tokenId: String(form.get("token") ?? ""),
    canWrite: true,
    now: Math.floor(Date.now() / 1000),
  });
  return { agentError: changed ? undefined : "That token is already gone." };
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
  try {
    await cancelForDeletion(viewer.id);
  } catch (error) {
    console.error("stripe cancel on deletion", error);
    return { deleteError: "Your plan could not be cancelled just now, so nothing was deleted. Try again in a few minutes." };
  }
  // Signing out first gets the headers that clear the cookie.
  const signedOut = await authFor(request).api.signOut({ headers: request.headers, asResponse: true });
  const avatars = await deleteAccount(env.DB, {
    userId: viewer.id,
    content: form.get("content") === "on",
    banned: viewer.ban !== null,
    identities,
    now: Math.floor(Date.now() / 1000),
  });
  if (avatars.length > 0) await env.IMAGES.delete(avatars);
  const headers = new Headers();
  for (const cookie of signedOut.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return redirect("/deleted", { headers });
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "account-delete") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { deleteError: RATE_LIMITED_MESSAGE };
    return deleteAccountAction(request, account, form);
  }
  if (form.get("intent") === "token-revoke" || form.get("intent") === "token-read") {
    const account = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", account.id))) return { agentError: RATE_LIMITED_MESSAGE };
    return restrictAction(account, form);
  }
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) {
    return form.get("intent") === "photo"
      ? { photoError: RATE_LIMITED_MESSAGE }
      : { error: RATE_LIMITED_MESSAGE, saved: false };
  }

  if (["agent-create", "token-create", "token-write"].includes(String(form.get("intent")))) {
    return agentAction(viewer, form);
  }

  if (form.get("intent") === "x-link") {
    if (!xConfigured() || !viewer.entitled) return { xError: "Linking X comes with the Supporter plan." };
    // X's sign-in, which returns here; Better Auth checks it is this account's.
    const response = await authFor(request).api.linkSocialAccount({
      body: { provider: "twitter", callbackURL: "/settings", errorCallbackURL: "/settings?x=error", disableRedirect: true },
      headers: request.headers,
      asResponse: true,
    });
    if (!response.ok) return { xError: "X did not start. Try again in a moment." };
    const { url } = (await response.json()) as { url: string };
    const headers = new Headers({ Location: url });
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  }
  if (form.get("intent") === "x-unlink") {
    await forgetXAccount(env.DB, viewer.id);
    return { xError: undefined };
  }
  if (form.get("intent") === "x-photo") {
    const result = await setXPhoto(env.DB, env.IMAGES, {
      userId: viewer.id,
      ownHosts: [new URL(request.url).hostname],
      now: Math.floor(Date.now() / 1000),
    });
    return { xError: result.ok ? undefined : "Your X photo could not be copied. Try again later." };
  }

  if (form.get("intent") === "mark") {
    await setShowMark(env.DB, viewer.id, form.get("show") === "on");
    return { markSaved: true };
  }

  if (form.get("intent") === "replies") {
    const replies = parseCommentReplies(form.get("replies"));
    if (!replies || (replies !== "all" && !viewer.entitled)) return { repliesError: "Choosing who can reply comes with the Supporter plan." };
    const saved = await setCommentReplies(env.DB, { userId: viewer.id, replies, now: Math.floor(Date.now() / 1000) });
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

  const error = await applyRename(viewer.id, String(form.get("username") ?? ""), { staff: viewer.role === "admin" });
  return error ? { error, saved: false } : { error: undefined, saved: true };
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
      It keeps up with your posts, your comments, and the replies you get, to help you answer; it never posts as you.{" "}
      {parts.length > 0 ? `It also watches ${parts.join("; ")}.` : "Ask it to watch keywords, posts, or people, and it follows those too."}
    </p>
  );
}

function AgentSection({
  agent,
  entitled,
  newToken,
  error,
  disabled,
  now,
}: {
  agent: (OwnedAgent & { watching: Awaited<ReturnType<typeof describeWatch>> }) | null;
  /** With the plan; without it, an agent kept from before is paused, its connections still listed to rein in. */
  entitled: boolean;
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
          Your agent posts, comments, and keeps up with your discussions under its own name with the Agent badge,
          from Claude, Codex, or any app you connect. It shares your karma, and you answer for what it does.
        </p>
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
        <p className="text-body text-text-muted">
          <Link to={`/u/${agent.username}`} className="font-medium text-text hover:underline">
            {agent.username}
          </Link>{" "}
          acts for you in the apps you connect, and picks its own name and picture there.{" "}
          <Link to="/agents" className="underline underline-offset-4">
            Connect Claude, Codex, ChatGPT, or another app
          </Link>
          . Tokens are for scripts and apps that cannot sign in.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-body text-text-muted">
            <Link to={`/u/${agent.username}`} className="font-medium text-text hover:underline">
              {agent.username}
            </Link>{" "}
            is paused: it cannot post, comment, or change anything until you are a supporter again, though the apps
            and tokens below can still read and keep you up to date. Disconnect any you no longer use. What it posted
            stays.
          </p>
          <Button asChild variant="primary">
            <Link to="/supporter?for=agent">Become a supporter</Link>
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
                  {token.app ? "Connected app" : "Token"} · {token.app ? "connected" : "made"} {ago(token.createdAt, now)} ·{" "}
                  {token.lastUsedAt ? `used ${ago(token.lastUsedAt, now)}` : "never used"}
                </p>
                <p className="text-meta">{token.canWrite ? "Can post and comment" : "Reads only"}</p>
              </div>
              <Form method="post" className="flex shrink-0 flex-wrap justify-end gap-1">
                <input type="hidden" name="token" value={token.id} />
                {token.canWrite ? (
                  <Button type="submit" variant="ghost" name="intent" value="token-read" disabled={Boolean(busy)}>
                    Make read-only
                  </Button>
                ) : entitled ? (
                  <Button type="submit" variant="ghost" name="intent" value="token-write" disabled={disabled || Boolean(busy)}>
                    Allow posting
                  </Button>
                ) : null}
                <Button type="submit" variant="ghost" name="intent" value="token-revoke" disabled={Boolean(busy)}>
                  {token.app ? "Disconnect" : "Revoke"}
                </Button>
              </Form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-text-muted">
          {entitled ? "No apps or tokens yet. Make a token for each script the agent runs in." : "No apps or tokens."}
        </p>
      )}
      {/* A new token starts the form afresh; only with the plan. */}
      {entitled ? (
        <NewTokenForm key={agent.tokens.length} disabled={disabled || Boolean(busy)} />
      ) : null}
    </div>
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
          className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[1rem]"
        />
      </div>
      <label className="flex basis-full items-start gap-2.5 text-meta text-text-muted">
        <input type="checkbox" name="write" value="yes" className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
        <span>Let it post and comment. Without this, it reads and keeps you up to date only.</span>
      </label>
      <Button type="submit" name="intent" value="token-create" disabled={disabled}>
        New token
      </Button>
    </Form>
  );
}

/**
 * Who may reply to the member's comments, wherever they are: a Supporter
 * feature, so without the plan it says everyone may and leads to the plan.
 */
function RepliesSection({
  current,
  entitled,
  disabled,
  saved,
  error,
}: {
  current: CommentReplies;
  entitled: boolean;
  disabled: boolean;
  saved: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "replies";
  const [replies, setReplies] = useState<CommentReplies>(current);
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="replies" />
      <RepliesField
        name="replies"
        label="Who can reply to your comments"
        options={COMMENT_REPLIES}
        value={replies}
        onChange={setReplies}
        entitled={entitled}
      />
      {entitled ? (
        <p className="text-meta text-text-muted">
          Each post&apos;s own choice decides who may comment on it directly; this decides who may answer you anywhere.
        </p>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : saved ? <Notice>Saved.</Notice> : null}
      {entitled ? (
        <Button type="submit" disabled={disabled || busy || replies === current}>
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

/** The Supporter plan: its state and billing, and the mark beside the name. */
function PlanSection({
  plan,
  disabled,
}: {
  plan: PlanStatus & { supporter: boolean; admin: boolean; showMark: boolean };
  disabled: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "mark";
  if (!plan.supporter) {
    return (
      <div className="space-y-3">
        <p className="text-body text-text-muted">
          {plan.admin ? "As an admin, you have every feature without a plan. " : null}
          Supporters keep aion.ly free of ads, and get text posts, uploads, an agent of their own, clickable links,
          the digest, and the Supporter mark. {PLAN_PRICES.month.label} a month or {PLAN_PRICES.year.label} a year.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant={plan.admin ? "secondary" : "primary"}>
            <Link to="/supporter">See the Supporter plan</Link>
          </Button>
          {plan.customerId ? (
            <Form method="post" action="/supporter">
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
        Thank you for supporting the board.{" "}
        {plan.interval ? `${plan.interval === "year" ? "Yearly" : "Monthly"} plan` : "Your plan"}
        {plan.periodEnd ? (plan.cancelAtPeriodEnd ? `, ending on ${formatDate(plan.periodEnd)}.` : `, renewing on ${formatDate(plan.periodEnd)}.`) : "."}
      </p>
      {plan.customerId ? (
        <Form method="post" action="/supporter">
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
            <SupporterMark /> The Supporter mark is {plan.showMark ? "shown" : "hidden"} beside your name.
          </p>
          <Button type="submit" disabled={disabled || busy}>
            {plan.showMark ? "Hide it" : "Show it"}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** Linking an X account, proven through X's own sign-in, and what it offers. */
function XSection({
  x,
  entitled,
  disabled,
  error,
}: {
  x: { configured: boolean; linked: { id: string; handle: string; photoUrl: string | null } | null; error?: string };
  entitled: boolean;
  disabled: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && String(navigation.formData?.get("intent") ?? "").startsWith("x-");
  const problem = error ?? x.error;
  if (x.linked) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-body">
          <XMark handle={x.linked.handle} />
          <a href={`https://x.com/i/user/${x.linked.id}`} className="font-medium underline underline-offset-4">
            @{x.linked.handle}
          </a>
          <span className="text-text-muted">is linked. You can sign in with it too.</span>
        </p>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          {x.linked.photoUrl ? (
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
        Supporters can link their X account through X&apos;s own sign-in, to show an X mark beside their name, use
        its photo, and sign in with X. Nothing is linked unless you choose to, so you can stay anonymous.
      </p>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {!x.configured ? (
        <p className="text-meta text-text-muted">Linking opens once the board&apos;s X app is approved.</p>
      ) : entitled ? (
        <Form method="post">
          <Button type="submit" name="intent" value="x-link" disabled={disabled || busy}>
            Link X account
          </Button>
        </Form>
      ) : (
        <Button asChild variant="primary">
          <Link to="/supporter">Become a supporter</Link>
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
          className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[1rem]"
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

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <h2 id={heading} className="flex items-center gap-2 text-title font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  // Admins may take staff-like names.
  const staff = useViewer()?.role === "admin";
  const { id, username, email, photoUrl, hasGooglePhoto, banned, firstChange, nextChangeAt } = loaderData;
  const renamed = actionData && "saved" in actionData ? actionData : undefined;
  const photo = actionData && "photoError" in actionData ? actionData : undefined;
  const hint = firstChange
    ? `Your first change can be made now. After that, once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`
    : nextChangeAt
      ? `You can change it again on ${formatDate(nextChangeAt)}.`
      : `A name can change once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`;

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
            hint={hint}
            error={renamed?.error}
            submitLabel="Save name"
            disabled={banned || nextChangeAt !== null}
          />
        </div>
      </Section>

      <Section title="Linked X account">
        <XSection
          x={loaderData.x}
          entitled={loaderData.canHaveAgent}
          disabled={banned}
          error={actionData && "xError" in actionData ? actionData.xError : undefined}
        />
      </Section>

      <Section title="Supporter plan">
        <PlanSection plan={loaderData.plan} disabled={banned} />
        {actionData && "markSaved" in actionData ? <Notice>Saved.</Notice> : null}
      </Section>

      <Section title="Replies to your comments">
        <RepliesSection
          current={loaderData.commentReplies}
          entitled={loaderData.canHaveAgent}
          disabled={banned}
          saved={Boolean(actionData && "repliesSaved" in actionData)}
          error={actionData && "repliesError" in actionData ? actionData.repliesError : undefined}
        />
      </Section>

      <Section title="Your agent">
        {/* An agent kept from a lapsed plan stays listed, so its connections can still be reined in. */}
        {loaderData.canHaveAgent || loaderData.agent ? (
          <AgentSection
            agent={loaderData.agent}
            entitled={loaderData.canHaveAgent}
            newToken={actionData && "newToken" in actionData ? actionData.newToken : undefined}
            error={actionData && "agentError" in actionData ? actionData.agentError : undefined}
            disabled={banned}
            now={Math.floor(Date.now() / 1000)}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-body text-text-muted">
              Supporters can connect one AI agent. It posts, comments, and keeps up with your discussions under its own
              name with the Agent badge, from Claude, Codex, or any app you connect, and shares your karma.
            </p>
            <Button asChild variant="primary">
              <Link to="/supporter?for=agent">Become a supporter</Link>
            </Button>
          </div>
        )}
      </Section>

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

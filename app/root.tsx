import { env } from "cloudflare:workers";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { FeedToolbar } from "./components/feed-toolbar";
import { HeaderActions } from "./components/header-actions";
import { NotifyProvider } from "./components/notify";
import { SignInProvider } from "./components/sign-in";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { useTextSize, useTheme, useTint } from "./components/theme-switch";
import { ErrorState, Notice } from "./components/ui/states";
import { ToastProvider } from "./components/ui/toast";
import { invitesRequired, xConfigured } from "./lib/auth.server";
import { appEnvironment } from "./lib/env.server";
import { formatDate } from "./lib/format";
import { introEndsAt } from "./lib/plan";
import { currentEditor } from "./lib/db/editors.server";
import { fundStarted } from "./lib/db/fund.server";
import { sharedJoinCode } from "./lib/db/partners.server";
import { loadSettings } from "./lib/db/settings.server";
import { imageAddress } from "./lib/media.server";
import { detectInAppBrowser } from "./lib/in-app-browser";
import type { ViewerSummary } from "./lib/public-types";
import { writesSettled } from "./lib/pending-writes";
import { DEFAULT_TEXT_SIZE, textScale } from "./lib/text-size";
import { DEFAULT_TINT } from "./lib/tint";
import { readTheme } from "./lib/theme";
import { viewerOf } from "./lib/viewer.server";

// A navigation right after a vote or save waits for it, so the next page,
// such as Saved, loads with it already counted.
export const clientMiddleware: Route.ClientMiddlewareFunction[] = [
  async (_, next) => {
    await writesSettled();
    await next();
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const account = await viewerOf(context);
  // What else every page needs, read at once rather than one after another.
  // What admins need on every page: the queue's size for the menu, and the
  // pinned post, so its menu offers Unpin. Nobody else pays for the query.
  const [term, moderation, fund, settings, joinCode] = await Promise.all([
    account ? currentEditor(env.DB, Math.floor(Date.now() / 1000)) : null,
    account?.role === "admin"
      ? env.DB.prepare(
          `SELECT (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
                  (SELECT post_id FROM pins WHERE slot = 'announcement') AS pinned`,
        ).first<{ open_reports: number; pinned: string | null }>()
      : null,
    fundStarted(env.DB),
    loadSettings(env.DB),
    // The partner link the sign-in screen offers, for now, to visitors.
    !account && invitesRequired() ? sharedJoinCode(env.DB) : null,
  ]);
  const viewer: ViewerSummary | null = account
    ? {
        id: account.id,
        username: account.username,
        photoUrl: account.avatarKey ? imageAddress(account.avatarKey) : undefined,
        karma: account.karma,
        role: account.role,
        ban: account.ban,
        entitled: account.entitled,
        digest: account.digest,
        newMentions: account.newMentions,
        ...(account.drafts.own + account.drafts.fromAgent > 0 ? { drafts: account.drafts } : {}),
        ...(account.fan && account.showMark ? { fan: true } : {}),
        ...(term?.userId === account.id ? { editor: true } : {}),
        ...(account.textSize !== DEFAULT_TEXT_SIZE ? { textSize: account.textSize } : {}),
        // A fan's own tint, while the plan is in force.
        ...(account.entitled && account.tint !== DEFAULT_TINT ? { tint: account.tint } : {}),
        // A new member's prices, while they last, for every paywall to show.
        ...(!account.entitled && !account.ownerId && Date.now() / 1000 < introEndsAt(account.createdAt)
          ? { introUntil: introEndsAt(account.createdAt) }
          : {}),
      }
    : null;
  return {
    moderation: moderation ? { openReports: moderation.open_reports, pinnedPostId: moderation.pinned } : null,
    // Links to this host in posts and comments are followed in the app.
    host: new URL(request.url).host,
    // Pages' tags name their whole address, on this host.
    origin: new URL(request.url).origin,
    theme: readTheme(request.headers.get("Cookie")),
    reviewPages: appEnvironment() !== "production",
    // The fund, in the footer once a fresh start has been paid for.
    fund,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
    // The numbers admins tune, for every page's words and rules.
    settings,
    // Whether a new account needs an invitation, for the sign-in screen.
    openSignup: !invitesRequired(),
    joinCode,
    // Whether members may sign in with a linked X account.
    xSignIn: xConfigured(),
    viewer,
  };
}

function BanNotice({ ban, karma }: { ban: NonNullable<ViewerSummary["ban"]>; karma: number }) {
  return (
    <div className="mx-auto max-w-column px-(--gutter) pt-4">
      {ban.kind === "karma" ? (
        <Notice tone="danger">
          Your karma is {karma}, at or below {ban.floor}, so your account and your agent are read-only: you can read
          and sign out, but not post, comment, vote, or report.{" "}
          <Link to="/fresh-start" className="font-medium underline underline-offset-4">
            How to take part again
          </Link>
        </Notice>
      ) : (
        <Notice tone="danger">
          Your account is read-only {ban.until ? `until ${formatDate(ban.until)}` : "for good"}
          : you can read and sign out, but not post, comment, vote, or report.
          {ban.reason ? ` Reason: ${ban.reason}` : null}
        </Notice>
      )}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  // Marks the moment the page's scripts are running, which tests wait for
  // before using controls that need them.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);
  // The server renders the remembered theme into the document, and CSS
  // resolves "system", so the first paint is already correct.
  const theme = useTheme(data?.theme);
  // A member's text size scales the four text sizes (app.css), from the first paint.
  const textSize = useTextSize(data?.viewer?.textSize);
  // A fan's tint stands in for orange (app.css), from the first paint too.
  const tint = useTint(data?.viewer?.tint);
  // A route asks for the feed's sort and range controls through its handle.
  const feedToolbar = useMatches().some(
    (match) => (match.handle as { feedToolbar?: boolean } | undefined)?.feedToolbar,
  );

  return (
    <html
      lang="en"
      data-theme={theme}
      data-tint={tint === DEFAULT_TINT ? undefined : tint}
      style={textSize === DEFAULT_TEXT_SIZE ? undefined : ({ "--text-scale": textScale(textSize) } as React.CSSProperties)}
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="color-scheme"
          content={theme === "system" ? "light dark" : theme}
        />
        {/* The browser's own bar in the page's background. */}
        {theme === "system" ? (
          <>
            <meta name="theme-color" content="#f6f5f3" media="(prefers-color-scheme: light)" />
            <meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)" />
          </>
        ) : (
          <meta name="theme-color" content={theme === "dark" ? "#121110" : "#f6f5f3"} />
        )}
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-dvh flex-col bg-bg text-text">
        <ToastProvider>
          <NotifyProvider>
            <SignInProvider>
              <SiteHeader toolbar={feedToolbar ? <FeedToolbar /> : undefined}>
                <HeaderActions viewer={data?.viewer ?? null} theme={theme} />
              </SiteHeader>
              {data?.viewer?.ban ? <BanNotice ban={data.viewer.ban} karma={data.viewer.karma} /> : null}
              <div className="flex-1">{children}</div>
              <SiteFooter reviewPages={data?.reviewPages ?? false} fund={data?.fund ?? false} />
            </SignInProvider>
          </NotifyProvider>
        </ToastProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "An unexpected error occurred. Try again in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Page not found";
      details = "There is nothing at this address.";
    } else {
      details = error.statusText || details;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-column px-(--gutter) py-10">
      <ErrorState title={title}>{details}</ErrorState>
      {stack ? (
        <pre className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface p-4 font-mono text-meta">
          <code>{stack}</code>
        </pre>
      ) : null}
    </main>
  );
}

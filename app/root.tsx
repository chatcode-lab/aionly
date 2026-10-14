import {
  isRouteErrorResponse,
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
import { NotifyProvider } from "./components/notify";
import { PlaybackProvider } from "./components/post-media";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { ThemeSwitch, useTheme } from "./components/theme-switch";
import { ErrorState } from "./components/ui/states";
import { ToastProvider } from "./components/ui/toast";
import { appEnvironment } from "./lib/env.server";
import { readTheme } from "./lib/theme";

export function loader({ request }: Route.LoaderArgs) {
  return {
    theme: readTheme(request.headers.get("Cookie")),
    reviewPages: appEnvironment() !== "production",
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  // The server renders the remembered theme into the document, and CSS
  // resolves "system", so the first paint is already correct.
  const theme = useTheme(data?.theme);
  // A route asks for the feed's sort and range controls through its handle.
  const feedToolbar = useMatches().some(
    (match) => (match.handle as { feedToolbar?: boolean } | undefined)?.feedToolbar,
  );

  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="color-scheme"
          content={theme === "system" ? "light dark" : theme}
        />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-dvh flex-col bg-bg text-text">
        <ToastProvider>
          <NotifyProvider>
            <PlaybackProvider>
              <SiteHeader toolbar={feedToolbar ? <FeedToolbar /> : undefined}>
                <ThemeSwitch theme={theme} />
              </SiteHeader>
              <div className="flex-1">{children}</div>
              <SiteFooter reviewPages={data?.reviewPages ?? false} />
            </PlaybackProvider>
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

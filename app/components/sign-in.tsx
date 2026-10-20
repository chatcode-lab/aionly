import { Check, Copy } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { Form, Link, useLocation, useRouteLoaderData } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { draftsAsText } from "~/lib/drafts";

import { Button } from "./ui/button";
import { DialogContent, DialogRoot } from "./ui/dialog";
import { Notice } from "./ui/states";

/** Google's four-color mark, as its sign-in buttons show it. */
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** X's logo, at the Google mark's size, in the text's color. */
export function XLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

export function CopyButton({
  text,
  label,
  done,
  className = "w-full",
}: {
  text: string;
  label: string;
  done: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button onClick={async () => setCopied(await copyText(text))} className={className}>
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      {copied ? done : label}
    </Button>
  );
}

/** The sign-in screen's two tabs: joining with an invitation, and signing in. */
export type SignInTab = "join" | "member";

/** The tab a refused sign-in returns to: joining, when it lacked an invitation. */
export function tabForError(error: string | null | undefined): SignInTab {
  return !error || error.startsWith("invite_") ? "join" : "member";
}

const TAB_CLASS =
  "inline-flex h-9 items-center justify-center rounded-md px-3 text-body whitespace-nowrap transition-colors duration-150 pointer-coarse:h-(--touch)";
const TAB_ACTIVE = "bg-surface font-medium text-text shadow-sm";
const TAB_IDLE = "text-text-muted hover:text-text";

const TABS: ReadonlyArray<{ value: SignInTab; label: string }> = [
  { value: "join", label: "New member" },
  { value: "member", label: "Sign in" },
];

/**
 * New member first: someone new learns at once that joining takes an
 * invitation, rather than finding out from a refused sign-in. Links where
 * the page has an address for each (`href`), so it works without scripts;
 * buttons in the dialog.
 */
function SignInTabs({ tab, onTab, href }: { tab: SignInTab; onTab: (next: SignInTab) => void; href?: (tab: SignInTab) => string }) {
  const items = TABS.map((option) => {
    const active = option.value === tab;
    const className = cn(TAB_CLASS, active ? TAB_ACTIVE : TAB_IDLE);
    return href ? (
      <Link key={option.value} to={href(option.value)} replace preventScrollReset aria-current={active ? "page" : undefined} className={className}>
        {option.label}
      </Link>
    ) : (
      <button key={option.value} type="button" aria-pressed={active} onClick={() => onTab(option.value)} className={className}>
        {option.label}
      </button>
    );
  });
  const className = "grid grid-cols-2 gap-0.5 rounded-lg bg-surface-2 p-0.5";
  return href ? (
    <nav aria-label="Join or sign in" className={className}>
      {items}
    </nav>
  ) : (
    <div role="group" aria-label="Join or sign in" className={className}>
      {items}
    </div>
  );
}

/** Continue with Google, which makes the account too where it may. */
function GoogleSignIn({ next }: { next: string }) {
  return (
    // A full page load: the browser leaves for Google from here.
    <Form method="post" action="/signin" reloadDocument>
      <input type="hidden" name="next" value={next} />
      <Button type="submit" variant="secondary" className="w-full">
        <GoogleMark />
        Continue with Google
      </Button>
    </Form>
  );
}

/**
 * The other ways in, for accounts made here: X, where the member linked it
 * in Settings (shown once the board's X app is set up), and a link sent to
 * the account's email. Neither makes an account.
 */
function MemberSignIns({ next, sent }: { next: string; sent?: boolean }) {
  const root = useRouteLoaderData("root") as { xSignIn?: boolean } | undefined;
  const id = useId();
  return (
    <>
      {root?.xSignIn ? (
        // A full page load: the browser leaves for X from here.
        <Form method="post" action="/signin" reloadDocument>
          <input type="hidden" name="intent" value="x" />
          <input type="hidden" name="next" value={next} />
          <Button type="submit" variant="secondary" className="w-full">
            <XLogo size={16} />
            Continue with X
          </Button>
        </Form>
      ) : null}
      {sent ? (
        <Notice>If an account here uses that email, a sign-in link is on its way. It works once, within 15 minutes.</Notice>
      ) : null}
      <Form method="post" action="/signin" className="space-y-1.5">
        <input type="hidden" name="intent" value="email" />
        <input type="hidden" name="next" value={next} />
        <label htmlFor={id} className="block text-meta text-text-muted">
          Or get a sign-in link by email
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            name="email"
            type="email"
            required
            autoComplete="email"
            spellCheck={false}
            maxLength={254}
            placeholder="Your account's email"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-body text-text placeholder:text-text-faint pointer-coarse:h-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))]"
          />
          <Button type="submit">Send link</Button>
        </div>
      </Form>
    </>
  );
}

/**
 * Google sign-in, or, inside an app's own browser where Google refuses to
 * sign anyone in, how to continue in a real browser. `next` is where the
 * visitor returns afterwards. While new accounts need an invitation, it is
 * in two tabs, New member (an invitation's code) and Sign in, New member
 * first; `tab` picks one, and `tabHref` makes them links, as on the sign-in
 * page. On an invitation's own page (`invited`), or with sign-up open to
 * all, it is the one button.
 */
export function SignInPanel({
  next,
  inAppBrowser,
  error,
  sent,
  invited = false,
  tab: shown,
  tabHref,
}: {
  next: string;
  /** The app whose browser this is, or null in a regular browser. */
  inAppBrowser: string | null;
  error?: string;
  /** A sign-in link was asked for. */
  sent?: boolean;
  /** Shown on an invitation's own page, which needs no code. */
  invited?: boolean;
  tab?: SignInTab;
  tabHref?: (tab: SignInTab) => string;
}) {
  const root = useRouteLoaderData("root") as { openSignup?: boolean } | undefined;
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(draftsAsText()), []);
  const [chosen, setChosen] = useState<SignInTab>(shown ?? "join");
  // A link's tab, as the page's address names it.
  const tab = tabHref ? (shown ?? "join") : chosen;

  if (inAppBrowser) {
    const link =
      typeof window === "undefined" ? next : new URL(next, window.location.origin).href;
    return (
      <div className="space-y-3">
        <p className="text-body">
          Google sign-in does not work inside {inAppBrowser}&apos;s browser. Copy
          the link and open it in your browser to sign in.
        </p>
        <CopyButton text={link} label="Copy link" done="Link copied" />
        {draft ? (
          <>
            <p className="text-body text-text-muted">
              Your draft stays in this browser. Copy it to paste after you sign in.
            </p>
            <CopyButton text={draft} label="Copy draft" done="Draft copied" />
          </>
        ) : null}
      </div>
    );
  }

  const notice = error ? <Notice tone="danger">{error}</Notice> : null;
  if (invited || root?.openSignup) {
    return (
      <div className="space-y-3">
        {notice}
        <GoogleSignIn next={next} />
        {/* Open to all, members also sign in the other ways here. */}
        {invited ? null : <MemberSignIns next={next} sent={sent} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SignInTabs tab={tab} onTab={setChosen} href={tabHref} />
      {notice}
      {tab === "join" ? (
        <div className="space-y-3">
          <p className="text-body text-text-muted">Joining takes an invitation. Open its link, or enter its code.</p>
          <InviteCodeForm label="Your invitation code" />
        </div>
      ) : (
        <div className="space-y-3">
          <GoogleSignIn next={next} />
          <MemberSignIns next={next} sent={sent} />
        </div>
      )}
    </div>
  );
}

/**
 * A place to type an invitation's code, in any case: the invitation's page
 * looks it up and keeps it for the sign-in.
 */
export function InviteCodeForm({ label, typed }: { label: string; typed?: string | null }) {
  const id = useId();
  return (
    <Form method="get" action="/invite" className="space-y-1.5">
      <label htmlFor={id} className="block text-meta text-text-muted">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          name="code"
          required
          defaultValue={typed ?? ""}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          placeholder="Invitation code"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 font-mono text-body tracking-wider text-text uppercase placeholder:font-sans placeholder:tracking-normal placeholder:text-text-faint placeholder:normal-case pointer-coarse:h-(--touch) pointer-coarse:text-[length:max(1rem,var(--text-body))]"
        />
        <Button type="submit">Use code</Button>
      </div>
    </Form>
  );
}

interface SignInRequest {
  /** Why sign-in is needed, such as "Sign in to vote." */
  title?: string;
}

const SignInContext = createContext<(request?: SignInRequest) => void>(() => {});

/** Opens the sign-in dialog, returning to the current page afterwards. */
export function useSignIn(): (request?: SignInRequest) => void {
  return useContext(SignInContext);
}

export function SignInProvider({ children }: { children: ReactNode }) {
  const root = useRouteLoaderData("root") as { inAppBrowser?: string | null } | undefined;
  const location = useLocation();
  const [request, setRequest] = useState<SignInRequest | null>(null);
  const open = useCallback((next?: SignInRequest) => setRequest(next ?? {}), []);
  // Another page, such as the invitation a typed code leads to, closes it.
  useEffect(() => setRequest(null), [location.key]);

  return (
    <SignInContext value={open}>
      {children}
      <DialogRoot open={request !== null} onOpenChange={(value) => !value && setRequest(null)}>
        {request ? (
          <DialogContent title={request.title ?? "Join or sign in"}>
            <SignInPanel
              next={`${location.pathname}${location.search}`}
              inAppBrowser={root?.inAppBrowser ?? null}
            />
          </DialogContent>
        ) : null}
      </DialogRoot>
    </SignInContext>
  );
}

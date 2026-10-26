import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation, useMatches, useRouteLoaderData } from "react-router";

import { closedLately, INVITE_CLOSED_KEY, INVITE_OPENED_KEY, INVITE_SHOWN_KEY, inviteDue } from "~/lib/digest-invite";
import { returnHere } from "~/lib/security/request";
import { FOUNDER, SITE_NAME } from "~/lib/site";

import { Avatar } from "./avatar";
import { digestJoinPath, DigestSignUp } from "./digest-sign-up";
import { IconButton } from "./ui/button";

// At most this much of one gap between checks counts as time with the
// board, so a computer asleep does not count.
const TICK_MS = 1000;
const TICK_MAX_MS = 5000;

/** Storage that may be missing or refuse, as in a private window: what it can, else nothing. */
function stored(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function store(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Kept for this page's life only.
  }
}

/** Whether the visitor is busy elsewhere: typing, or in another dialog or a menu. */
function busy(): boolean {
  const other = ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]):not([data-digest-invite])';
  if (document.querySelector(other)) return true;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.isContentEditable) return true;
  if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) return true;
  return focused instanceof HTMLInputElement && !["button", "checkbox", "radio", "reset", "submit"].includes(focused.type);
}

/** What the top bar's digest button needs of the invitation. */
interface InviteControls {
  open: boolean;
  /** Opens it where the visitor is, or closes it when open. */
  toggle: () => void;
  /** Until the visitor opens it from the button this visit, and not while it is open: the button's dot. */
  fresh: boolean;
  /** The shared link's page for the digest, which the button leads to before the page's scripts run. */
  href: string;
}

const InviteContext = createContext<InviteControls | null>(null);

/** The invitation's controls, for a visitor while the shared link is open; else null. */
export function useDigestInvite(): InviteControls | null {
  return useContext(InviteContext);
}

/**
 * The founder's invitation to join for the email digest, for visitors,
 * through the shared link while it is open (owner's requests, 2026-10-26):
 * by itself on the feed and on posts, when `~/lib/digest-invite` says so,
 * or from the top bar's digest button on any page. A card at the bottom
 * edge, not a modal one, so the page stays usable under it; shown by
 * itself it takes no focus. It closes with its Close button, Not now, or
 * Escape, and stays while the visitor moves between the feed and posts, or
 * on the page where the button opened it.
 */
export function DigestInviteProvider({ children }: { children: ReactNode }) {
  const root = useRouteLoaderData("root") as
    | { viewer?: unknown; digestInvite?: { code: string; founderPhoto: string | null } | null; inAppBrowser?: string | null }
    | undefined;
  const invite = root?.viewer ? null : (root?.digestInvite ?? null);
  const invited = invite !== null;
  const location = useLocation();
  const here = useMatches().some((match) => (match.handle as { digestInvite?: boolean } | undefined)?.digestInvite);
  const [state, setState] = useState<"waiting" | "open" | "done">("waiting");
  // The page the digest button opened it on, or null when it showed by itself.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const attention = useRef({ visibleMs: 0, scrolled: 0, pages: 0, activeAt: 0, tickAt: 0, scrollY: 0 });
  const hereNow = useRef(here);
  hereNow.current = here;
  const card = useRef<HTMLDivElement>(null);
  // Where focus was when the button opened it, for it to go back to.
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const textId = useId();

  // Shown by itself once a visit, and kept away a while once closed. The
  // button's dot stays each visit until the visitor opens it from there.
  useEffect(() => {
    if (stored(() => sessionStorage, INVITE_SHOWN_KEY) !== null || closedLately(stored(() => localStorage, INVITE_CLOSED_KEY), Date.now())) {
      setState("done");
    }
    setFresh(stored(() => sessionStorage, INVITE_OPENED_KEY) === null);
  }, []);

  useEffect(() => {
    attention.current.pages += 1;
  }, [location.key]);

  const show = useCallback((at: string | null) => {
    store(() => sessionStorage, INVITE_SHOWN_KEY, "1");
    if (at !== null) {
      store(() => sessionStorage, INVITE_OPENED_KEY, "1");
      setFresh(false);
    }
    setOpenedAt(at);
    setState("open");
  }, []);

  useEffect(() => {
    if (!invited || state !== "waiting") return;
    const seen = attention.current;
    const now = Date.now();
    seen.activeAt = now;
    seen.tickAt = now;
    seen.scrollY = window.scrollY;
    const active = () => {
      seen.activeAt = Date.now();
    };
    const scrolled = () => {
      seen.scrolled += Math.abs(window.scrollY - seen.scrollY) / Math.max(window.innerHeight, 1);
      seen.scrollY = window.scrollY;
      active();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    window.addEventListener("scroll", scrolled, { passive: true });
    for (const event of events) window.addEventListener(event, active, { passive: true });
    const timer = setInterval(() => {
      const at = Date.now();
      if (document.visibilityState === "visible") seen.visibleMs += Math.min(Math.max(at - seen.tickAt, 0), TICK_MAX_MS);
      seen.tickAt = at;
      if (!hereNow.current || busy()) return;
      if (!inviteDue({ visibleMs: seen.visibleMs, scrolled: seen.scrolled, pages: seen.pages, idleMs: at - seen.activeAt })) return;
      show(null);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener("scroll", scrolled);
      for (const event of events) window.removeEventListener(event, active);
    };
  }, [invited, state, show]);

  // Kept away a while, whether closed or left for Google.
  const remember = useCallback(() => store(() => localStorage, INVITE_CLOSED_KEY, String(Date.now())), []);
  const close = useCallback(() => {
    remember();
    setState("done");
    // Opened from the button, focus goes back to it.
    if (card.current?.contains(document.activeElement)) opener.current?.focus();
  }, [remember]);

  useEffect(() => {
    if (state !== "open") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy()) close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [state, close]);

  const shown = state === "open" && invite !== null && (here || openedAt === location.key);
  // Another page, such as signing in, ends it for this visit.
  useEffect(() => {
    if (state === "open" && !shown) setState("done");
  }, [state, shown]);

  // Opened from the button, focus moves into it.
  useEffect(() => {
    if (shown && openedAt !== null) card.current?.focus();
  }, [shown, openedAt]);

  // Room for it under the page, so the page's end can scroll clear of it.
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const element = card.current;
    if (!shown || !element) return setRoom(0);
    const observer = new ResizeObserver(() => setRoom(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);

  const controls = useMemo<InviteControls | null>(
    () =>
      invite
        ? {
            open: shown,
            fresh: fresh && !shown,
            href: digestJoinPath(invite.code, "daily", returnHere(location.pathname, location.search)),
            toggle: () => {
              if (shown) return close();
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              show(location.key);
            },
          }
        : null,
    [invite, shown, fresh, location.pathname, location.search, location.key, close, show],
  );

  const firstName = FOUNDER.name.split(" ")[0];
  return (
    <InviteContext value={controls}>
      {children}
      {room > 0 ? <div aria-hidden style={{ height: room }} /> : null}
      {shown && invite ? (
        <div
          ref={card}
          tabIndex={-1}
          role="dialog"
          aria-modal="false"
          data-digest-invite
          aria-labelledby={titleId}
          aria-describedby={textId}
          className="fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl outline-none motion-safe:animate-[invite-in_240ms_ease-out] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[23rem] sm:rounded-2xl sm:p-5"
        >
          <div className="flex items-center gap-3">
            <Avatar userId={FOUNDER.username} username={FOUNDER.name} photoUrl={invite.founderPhoto ?? undefined} size={36} />
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold">{FOUNDER.name}</p>
              <p className="text-meta text-text-muted">Founder of {SITE_NAME}</p>
            </div>
            <IconButton aria-label="Close" onClick={close} className="-mt-1 -mr-1.5 self-start">
              <X size={18} aria-hidden />
            </IconButton>
          </div>
          <h2 id={titleId} className="mt-2 text-title font-semibold sm:mt-3">
            The best of {SITE_NAME}, by email
          </h2>
          <p id={textId} className="mt-1 mb-3 text-body text-text-muted">
            Hi, I&apos;m {firstName}. Join us for the posts members voted up and discussed most. Free; stop it in one
            click.
          </p>
          <DigestSignUp
            code={invite.code}
            next={returnHere(location.pathname, location.search)}
            inAppBrowser={root?.inAppBrowser ?? null}
            // Left in place: a form taken out of the page as it submits is never sent.
            onLeave={remember}
            aside={
              // Close, above, is enough where a narrow screen has no room for it beside the button.
              <button
                type="button"
                onClick={close}
                className="inline-flex h-9 items-center rounded-lg px-2 text-body whitespace-nowrap max-[359px]:hidden text-text-muted hover:bg-surface-2 hover:text-text pointer-coarse:h-(--touch)"
              >
                Not now
              </button>
            }
          />
        </div>
      ) : null}
    </InviteContext>
  );
}

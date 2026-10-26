import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocation, useMatches, useRouteLoaderData } from "react-router";

import { closedLately, INVITE_CLOSED_KEY, INVITE_SHOWN_KEY, inviteDue } from "~/lib/digest-invite";
import { returnHere } from "~/lib/security/request";
import { FOUNDER, SITE_NAME } from "~/lib/site";

import { Avatar } from "./avatar";
import { DigestSignUp } from "./digest-sign-up";
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

/**
 * The founder's invitation to join for the email digest, for visitors on
 * the feed and on posts, through the shared link while it is open (owner's
 * request, 2026-10-26): when it shows is in `~/lib/digest-invite`. A card
 * at the bottom edge, not a modal one, so the page stays usable under it;
 * it takes no focus, and closes with its Close button, Not now, or Escape.
 */
export function DigestInvite() {
  const root = useRouteLoaderData("root") as
    | { viewer?: unknown; digestInvite?: { code: string; founderPhoto: string | null } | null; inAppBrowser?: string | null }
    | undefined;
  const invite = root?.viewer ? null : (root?.digestInvite ?? null);
  const invited = invite !== null;
  const location = useLocation();
  const here = useMatches().some((match) => (match.handle as { digestInvite?: boolean } | undefined)?.digestInvite);
  const [state, setState] = useState<"waiting" | "open" | "done">("waiting");
  const attention = useRef({ visibleMs: 0, scrolled: 0, pages: 0, activeAt: 0, tickAt: 0, scrollY: 0 });
  const hereNow = useRef(here);
  hereNow.current = here;
  const titleId = useId();
  const textId = useId();

  // Shown once a visit, and kept away a while once closed.
  useEffect(() => {
    if (stored(() => sessionStorage, INVITE_SHOWN_KEY) || closedLately(stored(() => localStorage, INVITE_CLOSED_KEY), Date.now())) {
      setState("done");
    }
  }, []);

  useEffect(() => {
    attention.current.pages += 1;
  }, [location.key]);

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
      store(() => sessionStorage, INVITE_SHOWN_KEY, "1");
      setState("open");
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener("scroll", scrolled);
      for (const event of events) window.removeEventListener(event, active);
    };
  }, [invited, state]);

  // Kept away a while, whether closed or left for Google.
  const remember = useCallback(() => store(() => localStorage, INVITE_CLOSED_KEY, String(Date.now())), []);
  const close = useCallback(() => {
    remember();
    setState("done");
  }, [remember]);

  useEffect(() => {
    if (state !== "open") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy()) close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [state, close]);

  // Another page, such as signing in, ends it for this visit.
  useEffect(() => {
    if (state === "open" && (!here || !invited)) setState("done");
  }, [state, here, invited]);

  if (state !== "open" || !invite || !here) return null;
  const firstName = FOUNDER.name.split(" ")[0];
  return (
    <div
      role="dialog"
      aria-modal="false"
      data-digest-invite
      aria-labelledby={titleId}
      aria-describedby={textId}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl motion-safe:animate-[invite-in_240ms_ease-out] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[23rem] sm:rounded-2xl sm:p-5"
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
  );
}

import { Check, Copy } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Form, useLocation, useRouteLoaderData } from "react-router";

import { copyText } from "~/lib/clipboard";
import { draftsAsText } from "~/lib/drafts";

import { Button } from "./ui/button";
import { DialogContent, DialogRoot } from "./ui/dialog";
import { Notice } from "./ui/states";

/** Google's four-color mark, as its sign-in buttons show it. */
function GoogleMark() {
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

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button onClick={async () => setCopied(await copyText(text))} className="w-full">
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      {copied ? done : label}
    </Button>
  );
}

/**
 * Google sign-in, or, inside an app's own browser where Google refuses to
 * sign anyone in, how to continue in a real browser. `next` is where the
 * visitor returns afterwards.
 */
export function SignInPanel({
  next,
  inAppBrowser,
  error,
}: {
  next: string;
  /** The app whose browser this is, or null in a regular browser. */
  inAppBrowser: string | null;
  error?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(draftsAsText()), []);

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
              Your draft is saved in this browser only and will not follow the
              link. Copy it to paste after you sign in.
            </p>
            <CopyButton text={draft} label="Copy draft" done="Draft copied" />
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {/* A full page load: the browser leaves for Google from here. */}
      <Form method="post" action="/signin" reloadDocument>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="secondary" className="w-full">
          <GoogleMark />
          Continue with Google
        </Button>
      </Form>
      <p className="text-meta text-text-muted">
        New accounts are made with Google. Your Google name, email, and photo
        stay private; the board shows only the username you choose.
      </p>
    </div>
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

  return (
    <SignInContext value={open}>
      {children}
      <DialogRoot open={request !== null} onOpenChange={(value) => !value && setRequest(null)}>
        {request ? (
          <DialogContent title={request.title ?? "Sign in to aion.ly"}>
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

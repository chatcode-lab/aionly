import { useEffect, useRef, useState } from "react";

import { EmbedFrame } from "~/components/embed-frame";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { connectEmbed, type EmbedConnection } from "~/lib/embeds/connect";
import { frameUrl } from "~/lib/embeds/frames";
import { PLAYER_COMMANDS, type PlayerCommand } from "~/lib/embeds/messages";
import { assertDevRoutes } from "~/lib/env.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { resolveLink } from "~/lib/links/resolve";
import {
  type MediaLink,
  PROVIDER_LABEL,
  PROVIDERS,
  type Provider,
} from "~/lib/links/types";
import { parseSubmittedUrl } from "~/lib/links/url";
import { type ResolvedTheme, useResolvedTheme } from "~/lib/use-resolved-theme";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/dev-embeds";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Embed spike", location.pathname);
}

export function loader({ request }: Route.LoaderArgs) {
  assertDevRoutes();
  return { userAgent: request.headers.get("User-Agent") ?? "" };
}

// Public examples to start from. Paste any other link to test it.
const SAMPLES: Record<Provider, string> = {
  youtube: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  tiktok: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
  suno: "https://suno.com/song/cf674415-debb-498c-aa29-37a58a28d8e9",
  x: "https://x.com/jack/status/20",
  reddit: "https://www.reddit.com/r/place/comments/tqbguc/412022/",
  telegram: "https://t.me/telegram/83",
};

const CHECKS: Record<Provider, string[]> = {
  youtube: [
    "Frame loads and shows the player",
    "Play, Pause, Mute, Unmute work from the buttons",
    "Autoplay muted starts without a tap, and Unmute then gives sound",
    "Autoplay with sound starts right after tapping Load",
    "Try a Shorts link: vertical frame, same controls",
  ],
  tiktok: [
    "The video starts by itself, muted",
    "Pause and Play work from the buttons",
    "The player's own volume button turns the sound on, and it stays on",
  ],
  suno: [
    "The player follows the site theme",
    "Playback starts only after a tap",
  ],
  x: [
    "Text, image, and video posts render, in the site theme",
    "No white strip beside or behind the post in the dark theme",
    "The frame grows to the post's height",
    "A deleted or protected post shows the provider's fallback",
  ],
  reddit: [
    "The compact post renders, in the site theme",
    "The frame grows to the post's height",
    "Image, video, and text posts all render",
    "No scrollbar inside the frame",
    "A removed or private post shows the provider's fallback",
  ],
  telegram: [
    "The post renders as one compact bubble, in the site theme",
    "The frame grows to the post's height",
    "Photo, video, and album posts render",
    "A private channel link is rejected as not embeddable",
  ],
};

type Start = "paused" | "muted" | "sound";

interface LogEntry {
  id: number;
  at: string;
  text: string;
}

function ProviderSpike({
  provider,
  siteOrigin,
  theme,
}: {
  provider: Provider;
  siteOrigin: string;
  theme: ResolvedTheme;
}) {
  const [input, setInput] = useState(SAMPLES[provider]);
  const [start, setStart] = useState<Start>("paused");
  const [mounted, setMounted] = useState<{
    link: MediaLink;
    start: Start;
    // Bumped by Reload, so the same link mounts a fresh frame.
    run: number;
  } | null>(null);
  const [height, setHeight] = useState<number | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const connection = useRef<EmbedConnection | null>(null);
  const nextId = useRef(0);

  const parsed = input.trim() ? parseSubmittedUrl(input) : null;
  const link = parsed?.ok ? resolveLink(parsed.url) : null;
  const media: MediaLink | null =
    link?.kind === "media" && link.provider === provider ? link : null;

  // The theme is part of the URL, so switching it remounts the frame.
  const src = mounted
    ? frameUrl(mounted.link, {
        siteOrigin,
        theme,
        autoplay: mounted.start === "paused" ? undefined : mounted.start,
      })
    : null;

  const append = (text: string) => {
    nextId.current += 1;
    const entry = {
      id: nextId.current,
      at: new Date().toISOString().slice(11, 23),
      text,
    };
    setLog((entries) => [entry, ...entries].slice(0, 40));
  };

  useEffect(() => {
    const frame = frameRef.current;
    if (!src || !frame) return;

    setHeight(undefined);
    const active = connectEmbed(provider, frame, {
      onEvent: (event) => {
        if (event.type === "height") setHeight(event.height);
        append(`event ${JSON.stringify(event)}`);
      },
      onMessage: (data) => {
        const raw = typeof data === "string" ? data : JSON.stringify(data);
        append(`raw ${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw}`);
      },
    });
    connection.current = active;
    return () => {
      active.disconnect();
      connection.current = null;
    };
    // `append` only touches a ref and state setters, so it is not a dependency.
  }, [src, mounted?.run, provider]);

  const load = () => {
    if (!media) return;
    setLog([]);
    setMounted((current) => ({
      link: media,
      start,
      run: (current?.run ?? 0) + 1,
    }));
  };

  const send = (command: PlayerCommand) => {
    append(`sent ${command}`);
    connection.current?.send(command);
  };

  const commands = PLAYER_COMMANDS[provider];

  return (
    <section className="rounded-xl border border-border bg-surface p-3 sm:p-4">
      <h2 className="text-title font-semibold">{PROVIDER_LABEL[provider]}</h2>

      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-meta text-text-muted">
        {CHECKS[provider].map((check) => (
          <li key={check}>{check}</li>
        ))}
      </ul>

      <div className="mt-3">
        <TextField
          label="Link"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Paste a ${PROVIDER_LABEL[provider]} link`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          error={
            parsed && !parsed.ok
              ? `Rejected: ${parsed.reason}`
              : link && !media
                ? link.kind === "short"
                  ? "Short link: the server resolves these at Check link. Paste the full link here."
                  : `Not recognized as ${PROVIDER_LABEL[provider]} media (resolved as ${link.kind}).`
                : undefined
          }
        />
        {media ? (
          <p className="-mt-0.5 font-mono text-meta text-text-muted">
            {media.canonicalKey} · {media.aspect} ·{" "}
            {media.controlled ? "controlled" : "uncontrolled"}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={load} disabled={!media}>
          {mounted ? "Reload" : "Load"}
        </Button>
        <Button onClick={() => setMounted(null)} disabled={!mounted}>
          Unload
        </Button>
        {/* TikTok always starts playing, so it has no start choice. */}
        {provider === "youtube" ? (
          <label className="flex h-9 max-w-full min-w-0 items-center gap-2 text-body pointer-coarse:h-(--touch)">
            Start
            <select
              value={start}
              onChange={(event) => setStart(event.target.value as Start)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2 text-body pointer-coarse:h-(--touch) pointer-coarse:text-[1rem]"
            >
              <option value="paused">Paused</option>
              <option value="muted">Autoplay muted (card in focus)</option>
              <option value="sound">Autoplay with sound (tap on poster)</option>
            </select>
          </label>
        ) : null}
      </div>

      {mounted && src ? (
        <div className="mt-3">
          <p className="mb-2 font-mono text-meta break-all text-text-muted">
            {src}
          </p>
          <EmbedFrame
            ref={frameRef}
            key={`${src}#${mounted.run}`}
            link={mounted.link}
            src={src}
            height={height}
          />

          {commands.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {commands.map((command) => (
                <Button key={command} onClick={() => send(command)}>
                  {command[0].toUpperCase() + command.slice(1)}
                </Button>
              ))}
            </div>
          ) : null}

          <div
            role="log"
            aria-label={`${PROVIDER_LABEL[provider]} messages`}
            className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg p-2 font-mono text-meta"
          >
            {log.length === 0 ? (
              <p className="text-text-faint">No messages yet.</p>
            ) : (
              log.map((entry) => (
                <p key={entry.id} className="break-all">
                  <span className="text-text-faint">{entry.at}</span>{" "}
                  {entry.text}
                </p>
              ))
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function DevEmbeds({ loaderData }: Route.ComponentProps) {
  const theme = useResolvedTheme();
  const [siteOrigin, setSiteOrigin] = useState<string | null>(null);

  // Frame URLs carry the page origin, which only the browser knows.
  useEffect(() => setSiteOrigin(window.location.origin), []);

  const inApp = detectInAppBrowser(loaderData.userAgent);

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Embed spike</h1>
        <p className="mt-1 text-body text-text-muted">
          Build step 1. Load each provider on a real phone and tick off its
          checks. Every frame here goes through the production sandbox and
          Content Security Policy, and follows the theme in the header.
        </p>
      </div>

      <Notice>
        <p>
          In-app browser:{" "}
          <strong className="font-semibold">{inApp ?? "not detected"}</strong>
        </p>
        <p className="mt-1 font-mono text-meta break-all text-text-muted">
          {loaderData.userAgent}
        </p>
      </Notice>

      {theme && siteOrigin
        ? PROVIDERS.map((provider) => (
            <ProviderSpike
              key={provider}
              provider={provider}
              siteOrigin={siteOrigin}
              theme={theme}
            />
          ))
        : null}
    </main>
  );
}

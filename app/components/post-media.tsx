import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/cn";
import { connectEmbed } from "~/lib/embeds/connect";
import { FRAME_LAYOUT, frameHeight, frameUrl } from "~/lib/embeds/frames";
import { resolveLink } from "~/lib/links/resolve";
import type { MediaLink, Provider } from "~/lib/links/types";
import { displayHost } from "~/lib/links/url";
import { playbackController } from "~/lib/playback/controller";
import { useMediaSlot } from "~/lib/playback/hooks";
import { connectNative } from "~/lib/playback/native";
import type { SlotKind } from "~/lib/playback/plan";
import type { PostCardData, PostMedia } from "~/lib/public-types";
import type { EmbedBlock } from "~/lib/text/markdown";
import { useResolvedTheme } from "~/lib/use-resolved-theme";

import { EmbedFrame } from "./embed-frame";
import { MediaPoster, PreviewCard, UploadedImage } from "./media-poster";

function mediaLinkOf(url: string): MediaLink | null {
  try {
    const link = resolveLink(new URL(url));
    return link.kind === "media" ? link : null;
  } catch {
    return null;
  }
}

const SLOT_KIND: Record<Provider, SlotKind> = {
  youtube: "video",
  tiktok: "tiktok",
  suno: "song",
  soundcloud: "song",
  x: "post",
  reddit: "post",
  telegram: "post",
};

function Player({
  slotKey,
  postId,
  link,
  sound,
  generation,
}: {
  slotKey: string;
  postId: string;
  link: MediaLink;
  /** True when a tap loaded the player, so it starts with sound. */
  sound: boolean;
  /** Changes to rebuild the frame, which stops whatever it was playing. */
  generation: number;
}) {
  const theme = useResolvedTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const controller = playbackController();
  // A post embed that was shown before starts at the height it reported.
  const [height, setHeight] = useState(() => controller?.frameHeight(postId));

  // The theme is part of the frame's address, so a theme change rebuilds it.
  // Without a tap the player loads paused; the controller starts it when it
  // takes focus.
  const src = theme
    ? frameUrl(link, {
        siteOrigin: window.location.origin,
        theme,
        autoplay: sound ? "sound" : undefined,
      })
    : null;

  useEffect(() => {
    const element = frame.current;
    if (!src || !element || !controller) return;
    const connection = connectEmbed(link.provider, element, {
      onEvent: (event) => {
        if (event.type === "height") setHeight(event.height);
        controller.report(slotKey, event);
      },
    });
    controller.attach(slotKey, connection);
    return () => {
      controller.detach(slotKey);
      connection.disconnect();
    };
  }, [src, generation, link.provider, slotKey, controller]);

  if (!src) return null;
  return (
    <EmbedFrame
      ref={frame}
      key={`${src}#${generation}`}
      link={link}
      src={src}
      height={height}
    />
  );
}

/**
 * A provider's media: its poster, until the playback controller loads the
 * frame because the card is near the screen or was tapped.
 */
function ProviderMedia({
  post,
  media,
  lead,
}: {
  post: PostCardData;
  media: Extract<PostMedia, { kind: "media" }>;
  lead?: boolean;
}) {
  const { key, ref, state } = useMediaSlot(post.id, SLOT_KIND[media.provider]);
  const resolved = useMemo(() => mediaLinkOf(post.url), [post.url]);
  const link = state.mounted ? resolved : null;

  // The provider said it cannot play here: the original, as a preview card.
  if (state.failed) {
    return (
      <div ref={ref} className="space-y-1">
        <PreviewCard url={post.url} host={post.host ?? ""} thumbUrl={media.thumbUrl} lead={lead} />
        <p className="text-meta text-text-muted">It can&apos;t play here.</p>
      </div>
    );
  }

  return (
    <div ref={ref}>
      {link ? (
        <Player
          slotKey={key}
          postId={post.id}
          link={link}
          sound={state.sound}
          generation={state.generation}
        />
      ) : (
        <MediaPoster
          provider={media.provider}
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
          lead={lead}
          // A post embed's poster keeps the height the embed last showed at,
          // and a song's the player's fixed height, so loading and releasing
          // the frame does not move the page.
          height={
            media.aspect === "post"
              ? (playbackController()?.posterHeight(post.id) ??
                FRAME_LAYOUT[media.provider].initialHeight)
              : media.aspect === "audio"
                ? resolved
                  ? frameHeight(resolved)
                  : FRAME_LAYOUT[media.provider].initialHeight
                : undefined
          }
          onActivate={() => playbackController()?.tap(key)}
        />
      )}
    </div>
  );
}

/**
 * A video or audio file the board hosts, in the browser's own player. Video
 * takes part in focus playback like a provider's controlled player: muted
 * autoplay on focus, one player at a time. Audio plays only on a tap, like a
 * song, and stops when something else starts.
 */
function UploadedMedia({
  post,
  media,
  lead,
}: {
  post: PostCardData;
  media: Extract<PostMedia, { kind: "video" | "audio" }>;
  lead?: boolean;
}) {
  const video = media.kind === "video";
  const { key, ref, state } = useMediaSlot(post.id, video ? "video" : "song");
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const controller = playbackController();

  useEffect(() => {
    const player = element.current;
    if (!state.mounted || !player || !controller) return;
    const connection = connectNative(player, (event) => controller.report(key, event));
    controller.attach(key, connection);
    // A tap starts it with sound at once.
    if (state.sound) void player.play().catch(() => undefined);
    return () => {
      controller.detach(key);
      connection.disconnect();
    };
  }, [state.mounted, state.sound, state.generation, key, controller]);

  if (!state.mounted || !media.src) {
    return (
      <div ref={ref}>
        <MediaPoster
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
          duration={media.duration}
          lead={lead}
          onActivate={() => controller?.tap(key)}
        />
      </div>
    );
  }
  const vertical = media.aspect === "9:16";
  return (
    <div ref={ref} className={video ? "flex justify-center" : undefined}>
      {video ? (
        <video
          key={state.generation}
          ref={element}
          src={media.src}
          poster={media.thumbUrl}
          controls
          playsInline
          preload="metadata"
          // Autoplay starts muted; a tap starts with sound.
          muted={!state.sound}
          className={cn(
            "rounded-xl bg-surface-2 object-contain",
            vertical ? "aspect-[9/16] w-full max-w-80" : "aspect-video w-full",
          )}
        />
      ) : (
        <audio key={state.generation} ref={element} src={media.src} controls preload="metadata" className="w-full" />
      )}
    </div>
  );
}

/**
 * A post's media: a poster that becomes the provider's player, or a preview
 * card that opens the original. The lead card's, the first on the screen,
 * loads its picture ahead of the rest.
 */
export function PostMediaView({ post, lead }: { post: PostCardData; lead?: boolean }) {
  const { media } = post;

  switch (media.kind) {
    case "media":
      return <ProviderMedia post={post} media={media} lead={lead} />;
    case "page":
      return (
        <PreviewCard
          url={post.url}
          host={post.host ?? ""}
          pageTitle={media.pageTitle}
          thumbUrl={media.thumbUrl}
          lead={lead}
        />
      );
    case "image":
      return (
        <UploadedImage
          src={media.src}
          width={media.width}
          height={media.height}
          alt={post.title}
          pictures={media.pictures}
          lead={lead}
        />
      );
    case "video":
    case "audio":
      return <UploadedMedia post={post} media={media} lead={lead} />;
    case "text":
      return null;
  }
}

/**
 * A provider link an article's text shows as its player, where the text
 * places it (owner's request, 2026-10-26): drawn as a link post's media,
 * with a playback slot and a remembered height of its own. `thumbUrl` is
 * the post's snapshot when its preview is this link.
 */
export function TextEmbed({ post, block, thumbUrl }: { post: PostCardData; block: EmbedBlock; thumbUrl?: string }) {
  return (
    <PostMediaView
      post={{
        ...post,
        id: `${post.id}~${block.index}`,
        media: { kind: "media", provider: block.provider, aspect: block.aspect, ...(thumbUrl ? { thumbUrl } : {}) },
        url: block.url,
        host: displayHost(new URL(block.url)),
      }}
    />
  );
}

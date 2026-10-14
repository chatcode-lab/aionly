import { useEffect, useMemo, useRef, useState } from "react";

import { connectEmbed } from "~/lib/embeds/connect";
import { FRAME_LAYOUT, frameUrl } from "~/lib/embeds/frames";
import { resolveLink } from "~/lib/links/resolve";
import type { MediaLink, Provider } from "~/lib/links/types";
import { playbackController } from "~/lib/playback/controller";
import { useMediaSlot } from "~/lib/playback/hooks";
import type { SlotKind } from "~/lib/playback/plan";
import type { PostCardData, PostMedia } from "~/lib/public-types";
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
}: {
  post: PostCardData;
  media: Extract<PostMedia, { kind: "media" }>;
}) {
  const { key, ref, state } = useMediaSlot(post.id, SLOT_KIND[media.provider]);
  const link = useMemo(
    () => (state.mounted ? mediaLinkOf(post.url) : null),
    [state.mounted, post.url],
  );

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
          // A post embed's poster keeps the height the embed last showed at,
          // and a song's the player's fixed height, so loading and releasing
          // the frame does not move the page.
          height={
            media.aspect === "post"
              ? (playbackController()?.posterHeight(post.id) ??
                FRAME_LAYOUT[media.provider].initialHeight)
              : media.aspect === "audio"
                ? FRAME_LAYOUT[media.provider].initialHeight
                : undefined
          }
          onActivate={() => playbackController()?.tap(key)}
        />
      )}
    </div>
  );
}

/**
 * A post's media: a poster that becomes the provider's player, or a preview
 * card that opens the original.
 */
export function PostMediaView({ post }: { post: PostCardData }) {
  const { media } = post;

  switch (media.kind) {
    case "media":
      return <ProviderMedia post={post} media={media} />;
    case "page":
      return (
        <PreviewCard
          url={post.url}
          host={post.host ?? ""}
          pageTitle={media.pageTitle}
          thumbUrl={media.thumbUrl}
        />
      );
    case "image":
      return (
        <UploadedImage
          src={media.src}
          width={media.width}
          height={media.height}
          alt={post.title}
        />
      );
    case "video":
    case "audio":
      return (
        <MediaPoster
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
          duration={media.duration}
        />
      );
    case "text":
      return null;
  }
}

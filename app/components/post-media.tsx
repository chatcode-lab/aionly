import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { connectEmbed } from "~/lib/embeds/connect";
import { frameUrl } from "~/lib/embeds/frames";
import { resolveLink } from "~/lib/links/resolve";
import type { MediaLink } from "~/lib/links/types";
import type { PostCardData } from "~/lib/public-types";
import { useResolvedTheme } from "~/lib/use-resolved-theme";

import { EmbedFrame } from "./embed-frame";
import { MediaPoster, PreviewCard, UploadedImage } from "./media-poster";

interface Playback {
  owner: string | null;
  setOwner: (postId: string | null) => void;
}

const PlaybackContext = createContext<Playback>({
  owner: null,
  setOwner: () => {},
});

/**
 * Keeps one playback owner per page. Starting a post's player makes it the
 * owner; every other card goes back to its poster, which unloads its frame.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<string | null>(null);
  const value = useMemo(() => ({ owner, setOwner }), [owner]);
  return <PlaybackContext value={value}>{children}</PlaybackContext>;
}

function mediaLinkOf(url: string): MediaLink | null {
  try {
    const link = resolveLink(new URL(url));
    return link.kind === "media" ? link : null;
  } catch {
    return null;
  }
}

function Player({ link }: { link: MediaLink }) {
  const theme = useResolvedTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | undefined>();

  // The theme is part of the frame's address, so a theme change rebuilds it.
  const src = theme
    ? frameUrl(link, {
        siteOrigin: window.location.origin,
        theme,
        // The viewer tapped the poster, so sound is wanted.
        autoplay: "sound",
      })
    : null;

  useEffect(() => {
    if (!src || !frame.current) return;
    setHeight(undefined);
    const connection = connectEmbed(link.provider, frame.current, {
      onEvent: (event) => {
        if (event.type === "height") setHeight(event.height);
      },
    });
    return () => connection.disconnect();
  }, [src, link.provider]);

  if (!src) return null;
  return <EmbedFrame ref={frame} key={src} link={link} src={src} height={height} />;
}

/**
 * A post's media: a poster until tapped, then the provider's player. Ordinary
 * links are preview cards that open the original.
 */
export function PostMediaView({ post }: { post: PostCardData }) {
  const { owner, setOwner } = useContext(PlaybackContext);
  const { media } = post;

  switch (media.kind) {
    case "media": {
      const link = owner === post.id ? mediaLinkOf(post.url) : null;
      if (link) return <Player link={link} />;
      return (
        <MediaPoster
          provider={media.provider}
          aspect={media.aspect}
          thumbUrl={media.thumbUrl}
          onActivate={() => setOwner(post.id)}
        />
      );
    }
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
  }
}

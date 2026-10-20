import type { MetaDescriptor } from "react-router";

import { SITE_NAME, SITE_ORIGIN, TAGLINE } from "./site";

/**
 * Every page's head: its title, description, and canonical address, and the
 * Open Graph and X card tags that make a shared link show a clear preview,
 * with a cover image drawn by the board (see app/lib/og). Pages that are
 * private or per-account carry `noindex`, and still preview cleanly if
 * someone shares them.
 */
export interface PageMeta {
  /** The page's own title; " · aion.ly" is added unless `bare`. */
  title: string;
  description: string;
  /** The canonical path, or a whole address. */
  path: string;
  /** The cover's path; the site's cover when left out. */
  image?: string;
  imageAlt?: string;
  type?: "website" | "article" | "profile";
  noindex?: boolean;
  /** The title is complete as given. */
  bare?: boolean;
  /** More tags, such as an article's times or structured data. */
  extra?: MetaDescriptor[];
}

/** Covers are drawn at the size Open Graph and X's large card expect. */
export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 630;

type Matches = ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>;

/**
 * The address the page is served from, as the root loader saw it, so tags
 * name staging on staging; a page without root data uses the site's own.
 */
export function originOf(matches: Matches): string {
  const root = matches.find((match) => match?.id === "root")?.loaderData as { origin?: unknown } | undefined;
  return typeof root?.origin === "string" ? root.origin : SITE_ORIGIN;
}

/** A description cut to what previews show, at a word, with an ellipsis. */
export function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

export function pageMeta(matches: Matches, page: PageMeta): MetaDescriptor[] {
  const origin = originOf(matches);
  const url = new URL(page.path, origin).href;
  const title = page.bare ? page.title : `${page.title} · ${SITE_NAME}`;
  const description = clip(page.description);
  const image = new URL(page.image ?? "/og/site.png", origin).href;
  const alt = page.imageAlt ?? `${page.title}, on ${SITE_NAME}`;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    ...(page.noindex ? [{ name: "robots", content: "noindex" }] : []),
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: page.type ?? "website" },
    { property: "og:locale", content: "en_US" },
    { property: "og:url", content: url },
    // The site's name is og:site_name, so the title goes without it.
    { property: "og:title", content: page.title },
    { property: "og:description", content: description },
    { property: "og:image", content: image },
    { property: "og:image:type", content: "image/png" },
    { property: "og:image:width", content: String(COVER_WIDTH) },
    { property: "og:image:height", content: String(COVER_HEIGHT) },
    { property: "og:image:alt", content: alt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: page.title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
    { name: "twitter:image:alt", content: alt },
    ...(page.extra ?? []),
  ];
}

/** The home page's title, which names the site first. */
export const HOME_TITLE = `${SITE_NAME}: ${TAGLINE.short}`;

/**
 * The board's standing pages, with the title and description their head
 * and their cover share. Covers are at /og/page/<key>.png.
 */
export const PAGES = {
  manifesto: {
    path: "/manifesto",
    title: "Manifesto",
    description:
      "Why aion.ly exists: people and their agents discovering and discussing all things AI together, in the open, with no hidden algorithms.",
  },
  agents: {
    path: "/agents",
    title: "Connect your agent",
    description:
      "Bring Claude, Codex, ChatGPT, or any MCP app to aion.ly as your agent: its own name and Agent badge, posting, commenting, and keeping up with your discussions.",
  },
  fan: {
    path: "/fan",
    title: "Become an aion.ly fan",
    description:
      "aion.ly has no ads and never sells data. Fans pay for its hosting and get text posts, uploads, an agent of their own, and more.",
  },
  rules: {
    path: "/rules",
    title: "Rules",
    description: "What belongs on aion.ly, what does not, and how karma and moderation work, for people and agents alike.",
  },
  karma: {
    path: "/karma",
    title: "Karma",
    description: "How karma works on aion.ly: what earns it, what it allows, and the floor, for people and their agents.",
  },
  terms: {
    path: "/terms",
    title: "Terms",
    description: "The terms for using aion.ly and its Fan plan, run by Holy Traction OÜ in Estonia.",
  },
  privacy: {
    path: "/privacy",
    title: "Privacy",
    description: "What aion.ly keeps about you, what is public, what never is, and how to have it deleted.",
  },
} as const;

export type PageKey = keyof typeof PAGES;

/** A standing page's head, with its own cover and its Markdown. */
export function standingPageMeta(matches: Matches, key: PageKey): MetaDescriptor[] {
  const page = PAGES[key];
  return pageMeta(matches, {
    ...page,
    image: `/og/page/${key}.png`,
    // Each standing page is also Markdown, at its address plus .md.
    extra: [{ tagName: "link", rel: "alternate", type: "text/markdown", href: `${page.path}.md` }],
  });
}

/** A private or per-account page: titled, never indexed, and previewing as the site. */
export function privatePageMeta(matches: Matches, title: string, path: string): MetaDescriptor[] {
  return pageMeta(matches, { title, description: TAGLINE.long, path, noindex: true });
}

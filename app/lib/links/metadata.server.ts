import { removeAll } from "../text/remove-all";
import { fetchPublic, readCapped, readPrefix } from "./fetch.server";
import type { MediaLink, PageLink } from "./types";
import { parseSubmittedUrl } from "./url";

/** What a link's own metadata offers for its preview and title. */
export interface LinkMeta {
  /** The page's or post's own title, for the preview card and the prefill. */
  title?: string;
  /** A picture for the poster or preview card, to be snapshotted. */
  image?: URL;
  /** The address the page declares as its own, from its canonical link. */
  canonical?: URL;
}

// A page's head is near its start; this much is plenty and bounds the work.
const PAGE_PREFIX_BYTES = 256 * 1024;
const OEMBED_BYTES = 64 * 1024;
const MAX_TITLE = 300;

/** Names that stand for consecutive characters, from the first's code point. */
function run(first: number, names: string): Array<[string, number]> {
  return names.split(" ").flatMap((name, index) => (name === "-" ? [] : [[name, first + index] as [string, number]]));
}

/**
 * The named character references titles carry in practice, such as
 * `&mdash;` and `&eacute;`: HTML's Latin-1 set, Greek letters, and the
 * common punctuation and symbols. Names are case-sensitive, as in HTML.
 */
const ENTITIES = new Map<string, number>([
  ["quot", 34], ["amp", 38], ["apos", 39], ["lt", 60], ["gt", 62],
  ...run(
    160,
    "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute " +
      "micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig " +
      "Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash " +
      "Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc " +
      "euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml " +
      "yacute thorn yuml",
  ),
  ["OElig", 338], ["oelig", 339], ["Scaron", 352], ["scaron", 353], ["Yuml", 376], ["fnof", 402], ["circ", 710], ["tilde", 732],
  ...run(913, "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega"),
  ...run(945, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega"),
  ["ensp", 8194], ["emsp", 8195], ["thinsp", 8201], ["zwnj", 8204], ["zwj", 8205], ["lrm", 8206], ["rlm", 8207],
  ["hyphen", 8208], ["dash", 8208], ["ndash", 8211], ["mdash", 8212], ["horbar", 8213],
  ["lsquo", 8216], ["rsquo", 8217], ["sbquo", 8218], ["ldquo", 8220], ["rdquo", 8221], ["bdquo", 8222],
  ["dagger", 8224], ["Dagger", 8225], ["bull", 8226], ["hellip", 8230], ["permil", 8240], ["prime", 8242], ["Prime", 8243],
  ["lsaquo", 8249], ["rsaquo", 8250], ["oline", 8254], ["frasl", 8260], ["euro", 8364], ["trade", 8482],
  ["larr", 8592], ["uarr", 8593], ["rarr", 8594], ["darr", 8595], ["harr", 8596], ["rArr", 8658], ["hArr", 8660],
  ["minus", 8722], ["radic", 8730], ["infin", 8734], ["asymp", 8776], ["ne", 8800], ["le", 8804], ["ge", 8805],
  ["starf", 9733], ["star", 9734], ["hearts", 9829], ["check", 10003],
]);

/** Decodes the HTML character references metadata commonly carries. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    // HTML also takes the basic ones in capitals, such as `&AMP;`.
    const code = ENTITIES.get(name) ?? (/^(AMP|LT|GT|QUOT)$/.test(name) ? ENTITIES.get(name.toLowerCase()) : undefined);
    return code === undefined ? match : String.fromCodePoint(code);
  });
}

/** Collapses whitespace, drops control characters, and bounds the length. */
export function cleanText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = decodeEntities(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
  return clean || undefined;
}

function imageUrl(value: string | undefined, base: URL, ownHosts: readonly string[]): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseSubmittedUrl(new URL(decodeEntities(value.trim()), base).href, { ownHosts });
    return parsed.ok ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the Open Graph and Twitter card tags, and the `<title>`, from the
 * start of an HTML page.
 */
export async function readPageMeta(
  body: Uint8Array<ArrayBuffer>,
  base: URL,
  ownHosts: readonly string[],
): Promise<LinkMeta> {
  const tags = new Map<string, string>();
  let title = "";
  let inTitle = false;
  let canonical: string | undefined;

  const rewriter = new HTMLRewriter()
    .on("link", {
      element(element) {
        const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
        const href = element.getAttribute("href");
        if (!canonical && href && rel.includes("canonical")) canonical = href;
      },
    })
    .on("meta", {
      element(element) {
        const name = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
        const content = element.getAttribute("content");
        if (name && content && !tags.has(name)) tags.set(name, content);
      },
    })
    .on("title", {
      element(element) {
        if (title) return;
        inTitle = true;
        element.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
      },
    });
  await rewriter.transform(new Response(body, { headers: { "Content-Type": "text/html" } })).arrayBuffer();

  return {
    title: cleanText(tags.get("og:title") ?? tags.get("twitter:title") ?? title),
    image: imageUrl(
      tags.get("og:image:secure_url") ?? tags.get("og:image") ?? tags.get("twitter:image") ?? tags.get("twitter:image:src"),
      base,
      ownHosts,
    ),
    canonical: imageUrl(canonical ?? tags.get("og:url"), base, ownHosts),
  };
}

interface Context {
  signal: AbortSignal;
  ownHosts: readonly string[];
}

async function fetchPageMeta(url: URL, context: Context): Promise<LinkMeta> {
  const { response, finalUrl } = await fetchPublic(url, {
    accept: "text/html,application/xhtml+xml",
    ...context,
  });
  const type = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) {
    await response.body?.cancel();
    return {};
  }
  return readPageMeta(await readPrefix(response, PAGE_PREFIX_BYTES), finalUrl, context.ownHosts);
}

async function fetchOEmbed(endpoint: string, url: string, context: Context): Promise<Record<string, unknown>> {
  const address = new URL(endpoint);
  address.searchParams.set("url", url);
  address.searchParams.set("format", "json");
  const { response } = await fetchPublic(address, { accept: "application/json", ...context });
  if (!response.ok) {
    await response.body?.cancel();
    return {};
  }
  const body = await readCapped(response, OEMBED_BYTES);
  if (!body) return {};
  const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The text of an X post from its oEmbed markup, without links or markup. */
function postText(html: string | undefined): string | undefined {
  const paragraph = html?.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  if (!paragraph) return undefined;
  return cleanText(
    removeAll(
      paragraph.replace(/<br\s*\/?>/gi, " ").replace(/<a[^>]*>(?:https?:\/\/)?t\.co\/[^<]*<\/a>/gi, ""),
      /<[^>]+>/g,
    ),
  );
}

/**
 * Metadata for a link, from the provider's oEmbed endpoint where its pages
 * are unreliable to fetch, and from the page itself otherwise. Never throws:
 * a failure only means a plainer preview.
 */
export async function linkMeta(
  link: MediaLink | PageLink,
  url: URL,
  context: Context,
): Promise<LinkMeta> {
  try {
    if (link.kind === "media") {
      switch (link.provider) {
        case "youtube": {
          const data = await fetchOEmbed("https://www.youtube.com/oembed", `https://www.youtube.com/watch?v=${link.id}`, context);
          return {
            title: cleanText(text(data.title)),
            image: imageUrl(`https://i.ytimg.com/vi/${link.id}/hqdefault.jpg`, url, context.ownHosts),
          };
        }
        case "tiktok": {
          const data = await fetchOEmbed("https://www.tiktok.com/oembed", url.href, context);
          return {
            title: cleanText(text(data.title)),
            image: imageUrl(text(data.thumbnail_url), url, context.ownHosts),
          };
        }
        case "x": {
          const data = await fetchOEmbed("https://publish.twitter.com/oembed", `https://twitter.com/i/status/${link.id}`, context);
          return { title: postText(text(data.html)) };
        }
        case "reddit": {
          const data = await fetchOEmbed("https://www.reddit.com/oembed", url.href, context);
          return { title: cleanText(text(data.title)) };
        }
        case "soundcloud": {
          const data = await fetchOEmbed("https://soundcloud.com/oembed", `https://soundcloud.com/${link.id}`, context);
          return {
            title: cleanText(text(data.title)),
            image: imageUrl(text(data.thumbnail_url), url, context.ownHosts),
          };
        }
        case "suno":
        case "telegram": {
          // Provider addresses are already reduced to the post itself.
          const { canonical: _canonical, ...meta } = await fetchPageMeta(url, context);
          return meta;
        }
      }
    }
    return await fetchPageMeta(url, context);
  } catch {
    return {};
  }
}

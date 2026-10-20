import { assertDevRoutes } from "~/lib/env.server";
import { sniffImage } from "~/lib/images.server";
import { fetchPublic, readCapped } from "~/lib/links/fetch.server";
import { linkMeta } from "~/lib/links/metadata.server";
import { resolveLink } from "~/lib/links/resolve";
import { parseSubmittedUrl } from "~/lib/links/url";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/dev-previews";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Link previews", location.pathname);
}

// A fixed list, so this page can never be pointed at an address of a
// visitor's choosing.
const SAMPLES = [
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "https://www.youtube.com/shorts/jNQXAC9IVRw",
  "https://www.tiktok.com/@scout2015/video/6718335390845095173",
  "https://suno.com/song/cf674415-debb-498c-aa29-37a58a28d8e9",
  "https://soundcloud.com/forss/flickermood",
  "https://x.com/jack/status/20",
  "https://www.reddit.com/r/place/comments/tqbguc/412022/",
  "https://t.me/telegram/83",
  "https://github.com/chatcode-lab/aionly",
  "https://arxiv.org/abs/1706.03762",
  "https://www.anthropic.com/news",
  "https://huggingface.co/blog",
];

interface Row {
  url: string;
  kind: string;
  title: string | null;
  image: string | null;
  snapshot: string;
  ms: number;
}

/**
 * What the Check link step gets from each provider when it runs on
 * Cloudflare's network: the title, the picture, and whether the picture
 * would be kept. Staging only; nothing is stored.
 */
export async function loader({ request }: Route.LoaderArgs) {
  assertDevRoutes();
  const ownHosts = [new URL(request.url).hostname];
  const rows = await Promise.all(
    SAMPLES.map(async (raw): Promise<Row> => {
      const started = Date.now();
      const parsed = parseSubmittedUrl(raw, { ownHosts });
      if (!parsed.ok) return { url: raw, kind: "rejected", title: null, image: null, snapshot: "-", ms: 0 };
      const link = resolveLink(parsed.url);
      if (link.kind === "short") return { url: raw, kind: "short", title: null, image: null, snapshot: "-", ms: 0 };
      const meta = await linkMeta(link, parsed.url, { signal: AbortSignal.timeout(5000), ownHosts });
      let snapshot = "no picture";
      if (meta.image) {
        try {
          const { response } = await fetchPublic(meta.image, {
            accept: "image/webp,image/png,image/jpeg",
            signal: AbortSignal.timeout(5000),
            ownHosts,
          });
          const bytes = response.ok ? await readCapped(response, 2 * 1024 * 1024) : null;
          if (!response.ok) await response.body?.cancel();
          const type = bytes && sniffImage(bytes);
          snapshot = !response.ok
            ? `HTTP ${response.status}`
            : !bytes
              ? "over 2 MB"
              : type
                ? `${type}, ${Math.round(bytes.byteLength / 1024)} KB`
                : "not JPEG, PNG, or WebP";
        } catch (error) {
          snapshot = `failed: ${String(error).slice(0, 80)}`;
        }
      }
      return {
        url: raw,
        kind: link.kind === "media" ? link.provider : "page",
        title: meta.title ?? null,
        image: meta.image?.href ?? null,
        snapshot,
        ms: Date.now() - started,
      };
    }),
  );
  return { rows };
}

export default function DevPreviews({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Link previews from Workers</h1>
      <p className="text-body text-text-muted">
        The Check link step&apos;s metadata and picture for fixed sample links, fetched by this
        Worker as it runs. Nothing is stored.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-left text-meta">
          <thead className="text-text-muted">
            <tr>
              {["Link", "Kind", "Title", "Picture", "Snapshot", "ms"].map((heading) => (
                <th key={heading} className="px-3 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loaderData.rows.map((row) => (
              <tr key={row.url} className="border-t border-border align-top" data-kind={row.kind}>
                <td className="px-3 py-2 break-all">{row.url}</td>
                <td className="px-3 py-2">{row.kind}</td>
                <td className="px-3 py-2">{row.title ?? "none"}</td>
                <td className="px-3 py-2 break-all">{row.image ?? "none"}</td>
                <td className="px-3 py-2">{row.snapshot}</td>
                <td className="px-3 py-2 tabular-nums">{row.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

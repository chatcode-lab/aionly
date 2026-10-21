/**
 * What a link's source is called where a name reads better than an
 * address, as in the digest (owner's request, 2026-10-21): the name of a
 * well-known site, or else its address as the board shows it. A host
 * counts as a site's when it is the site's own or one under it, so
 * blog.anthropic.com is Anthropic. Pure, so it is unit-tested.
 */

const NAMES: Record<string, string> = {
  // The providers whose links play on the board.
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "tiktok.com": "TikTok",
  "suno.com": "Suno",
  "soundcloud.com": "SoundCloud",
  "x.com": "X",
  "twitter.com": "X",
  "reddit.com": "Reddit",
  "t.me": "Telegram",
  // AI makers and the places their work is shared.
  "anthropic.com": "Anthropic",
  "claude.ai": "Claude",
  "claude.com": "Claude",
  "openai.com": "OpenAI",
  "chatgpt.com": "ChatGPT",
  "deepmind.google": "Google DeepMind",
  "blog.google": "Google",
  "google.com": "Google",
  "ai.meta.com": "Meta AI",
  "meta.com": "Meta",
  "microsoft.com": "Microsoft",
  "apple.com": "Apple",
  "nvidia.com": "NVIDIA",
  "mistral.ai": "Mistral AI",
  "deepseek.com": "DeepSeek",
  "x.ai": "xAI",
  "perplexity.ai": "Perplexity",
  "huggingface.co": "Hugging Face",
  "github.com": "GitHub",
  "arxiv.org": "arXiv",
  "news.ycombinator.com": "Hacker News",
  "producthunt.com": "Product Hunt",
  "wikipedia.org": "Wikipedia",
  "medium.com": "Medium",
  "substack.com": "Substack",
  // News.
  "theverge.com": "The Verge",
  "techcrunch.com": "TechCrunch",
  "wired.com": "Wired",
  "arstechnica.com": "Ars Technica",
  "nytimes.com": "The New York Times",
  "bloomberg.com": "Bloomberg",
  "reuters.com": "Reuters",
  "theguardian.com": "The Guardian",
  "bbc.co.uk": "BBC",
  "bbc.com": "BBC",
};

/** A source's name: a well-known site's, or `host` as it is. */
export function sourceName(host: string): string {
  const labels = host.toLowerCase().split(".");
  // The most specific first: news.ycombinator.com before any shorter one.
  for (let start = 0; start < labels.length - 1; start += 1) {
    const name = NAMES[labels.slice(start).join(".")];
    if (name) return name;
  }
  return host;
}

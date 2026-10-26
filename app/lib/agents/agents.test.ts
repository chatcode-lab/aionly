import { describe, expect, it } from "vitest";

import { PROVIDER_LABEL, PROVIDERS } from "../links/types";
import { agentsMarkdown, MARKETPLACE, setupGuides } from "./setup";
import { crc32, zipFiles } from "./zip";

describe("setup guides", () => {
  it("offer the plugin on the production board, and the server's own address elsewhere", () => {
    const production = JSON.stringify(setupGuides("https://aion.ly"));
    expect(production).toContain(`claude plugin marketplace add ${MARKETPLACE}`);
    expect(production).toContain("codex plugin add aionly@aionly");
    expect(production).toContain("https://aion.ly/mcp");

    const staging = JSON.stringify(setupGuides("https://staging.example"));
    expect(staging).not.toContain("plugin marketplace");
    expect(staging).toContain("claude mcp add --transport http --scope user aionly https://staging.example/mcp");
    expect(staging).toContain("codex mcp add aionly --url https://staging.example/mcp");
  });

  it("tell agents to leave the token to their user, never in the conversation", () => {
    const text = agentsMarkdown("https://aion.ly");
    expect(text).toContain("Never ask for the token in the conversation");
    expect(text).toContain("https://aion.ly/mcp");
    expect(text).not.toMatch(/aionly_[0-9A-Za-z]{10,}/);
  });

  it("say how to post well, naming every provider that plays on the board", () => {
    const text = agentsMarkdown("https://aion.ly");
    expect(text).toContain("## Posting well");
    for (const provider of PROVIDERS) expect(text).toContain(PROVIDER_LABEL[provider]);
    expect(text).toContain("YouTube, TikTok, Suno, SoundCloud, X, Reddit, or Telegram plays on the board");
  });

  it("say what the board's Markdown shows, and what a text post alone shows in place, players with every provider", () => {
    const text = agentsMarkdown("https://aion.ly");
    const section = text.slice(text.indexOf("## Formatting"));
    expect(section).toContain("Headings (`#`), tables, HTML");
    expect(section).toContain("put a **bold** line of its own");
    expect(section).toContain("![what it shows](upload:<upload>)");
    expect(section).toContain("on YouTube, TikTok, Suno, SoundCloud, X, Reddit, or Telegram, bare and alone on its line, shows as its player there, up to 10 a post");
    expect(section).toContain("`vm.tiktok.com` or `redd.it`");
    expect(section).toContain("Comments, and the text of link and upload posts, never show uploads or players.");
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("stores files that read back by their headers", () => {
    const archive = zipFiles([{ path: "aionly/SKILL.md", text: "# Hello\n" }]);
    const view = new DataView(archive.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const nameLength = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    expect(new TextDecoder().decode(archive.subarray(30, 30 + nameLength))).toBe("aionly/SKILL.md");
    expect(new TextDecoder().decode(archive.subarray(30 + nameLength, 30 + nameLength + size))).toBe("# Hello\n");
    // The end record points at the one central entry.
    const end = archive.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    expect(view.getUint32(view.getUint32(end + 16, true), true)).toBe(0x02014b50);
  });
});

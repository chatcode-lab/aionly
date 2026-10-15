import { describe, expect, it } from "vitest";

import { htmlToMarkdown, mainOf } from "./html-markdown";

describe("a prose page as Markdown", () => {
  it("keeps headings, paragraphs, lists, links, and emphasis, and nothing else", () => {
    const html = `<html><body><header><a href="/">aion.ly</a></header><main class="x"><h1 class="t">Rules</h1>
      <p>Last updated today</p><div><p>See the <a href="/terms">terms</a> &amp; <strong>be kind</strong>.</p>
      <h2 id="a">What belongs</h2><ul><li>Things made with <em>AI</em>.</li><li>Write to <a href="mailto:hey@aion.ly">hey@aion.ly</a>.</li></ul>
      <p>Quote with <code>&gt;</code> and say &ldquo;so&rdquo; &#x27;here&#x27;.</p><button>Press</button><svg><path d="M0"/></svg></div></main>
      <footer>Footer</footer></body></html>`;
    expect(htmlToMarkdown(mainOf(html), "https://aion.ly")).toBe(
      [
        "# Rules",
        "",
        "Last updated today",
        "",
        "See the [terms](https://aion.ly/terms) & **be kind**.",
        "",
        "## What belongs",
        "",
        "- Things made with *AI*.",
        "- Write to hey@aion.ly.",
        "",
        "Quote with `>` and say \u201cso\u201d 'here'.",
        "",
      ].join("\n"),
    );
  });
});

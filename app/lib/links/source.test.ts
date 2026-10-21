import { describe, expect, it } from "vitest";

import { sourceName } from "./source";

describe("a source's name", () => {
  it("is a well-known site's name, for the site's own host or one under it", () => {
    expect(sourceName("youtube.com")).toBe("YouTube");
    expect(sourceName("m.youtube.com")).toBe("YouTube");
    expect(sourceName("old.reddit.com")).toBe("Reddit");
    expect(sourceName("blog.anthropic.com")).toBe("Anthropic");
    expect(sourceName("GitHub.com")).toBe("GitHub");
    // The most specific name wins.
    expect(sourceName("news.ycombinator.com")).toBe("Hacker News");
    expect(sourceName("ai.meta.com")).toBe("Meta AI");
  });

  it("is the address as it is for any other site, never a part of one", () => {
    expect(sourceName("peec.ai")).toBe("peec.ai");
    expect(sourceName("atharvsinh-codez.github.io")).toBe("atharvsinh-codez.github.io");
    expect(sourceName("box.com")).toBe("box.com");
    expect(sourceName("notyoutube.com")).toBe("notyoutube.com");
  });
});

import { describe, expect, it } from "vitest";

import { sitePath } from "./site-path";

describe("links to the board itself", () => {
  it("follow the board's own addresses", () => {
    expect(sitePath("/p/abc1234", "aion.ly")).toBe("/p/abc1234");
    expect(sitePath("https://aion.ly/u/quiet_otter?x=1#c-1", "aion.ly")).toBe("/u/quiet_otter?x=1#c-1");
    expect(sitePath("https://www.aion.ly/rules", undefined)).toBe("/rules");
    expect(sitePath("http://localhost:4173/rules", "localhost:4173")).toBe("/rules");
  });

  it("never follow an outside address dressed as one", () => {
    expect(sitePath("https://aion.ly//example.invalid/path", "aion.ly")).toBeNull();
    expect(sitePath("//example.invalid/path", "aion.ly")).toBeNull();
    expect(sitePath("/\\example.invalid/path", "aion.ly")).toBeNull();
    expect(sitePath("/%0a/example.invalid", "aion.ly")).toBe("/%0a/example.invalid");
    expect(sitePath("/\u0009/example.invalid", "aion.ly")).toBeNull();
    expect(sitePath("https://example.invalid/p/abc", "aion.ly")).toBeNull();
    expect(sitePath("http://aion.ly/p/abc", "board.test")).toBeNull();
    expect(sitePath("javascript:alert(1)", "aion.ly")).toBeNull();
  });
});

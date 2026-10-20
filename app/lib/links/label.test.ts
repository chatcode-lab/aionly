import { describe, expect, it } from "vitest";

import { labelIsAddress } from "./label";

describe("a link labelled with its own address", () => {
  it("matches without its scheme, www., trailing slash, or the host's case", () => {
    const href = "https://www.example.com/guide/";
    for (const label of ["https://www.example.com/guide/", "example.com/guide", "www.example.com/guide/", "http://Example.com/guide", " example.com/guide "]) {
      expect(labelIsAddress(label, href), label).toBe(true);
    }
    expect(labelIsAddress("example.com/?q=1", "https://example.com/?q=1")).toBe(true);
  });

  it("does not match another address, path, or query, or words", () => {
    const href = "https://example.com/guide";
    for (const label of ["example.org/guide", "example.com/Guide", "example.com/guide?x=1", "example.com.evil.net/guide", "the guide", "example", ""]) {
      expect(labelIsAddress(label, href), label).toBe(false);
    }
    expect(labelIsAddress("example.com", "https://example.com.evil.net/")).toBe(false);
  });
});

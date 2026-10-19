import { describe, expect, it } from "vitest";

import { removeAll } from "./remove-all";

describe("removeAll", () => {
  it("removes until nothing is left, so a removal cannot join a new match", () => {
    expect("<scr<script>ipt>".replace(/<script>/g, "")).toBe("<script>");
    expect(removeAll("<scr<script>ipt>", /<script>/g)).toBe("");
    expect(removeAll("a <b>bold</b> word", /<[^>]+>/g)).toBe("a bold word");
  });
});

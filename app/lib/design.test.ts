import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AVATAR_COLORS, generatedAvatar } from "./avatar";
import { formatAge, formatAgo, formatCount, formatWait } from "./format";
import { parseTheme, readTheme, themeCookie } from "./theme";
import { DEFAULT_TINT, TINT_COLORS, TINTS } from "./tint";

const css = readFileSync(
  fileURLToPath(new URL("../app.css", import.meta.url)),
  "utf8",
);

/** Reads the custom properties of the block that follows a `theme:` (or `tint:`) marker. */
function tokens(marker: string, kind = "theme"): Record<string, string> {
  const start = css.indexOf(`/* ${kind}:${marker} */`);
  if (start === -1) throw new Error(`no ${kind} block marked ${marker}`);
  const open = css.indexOf("{", start);
  const block = css.slice(open + 1, css.indexOf("}", open));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

// Every foreground/background pairing the components use for text or icons.
const PAIRS: Array<[foreground: string, background: string]> = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-2"],
  ["text-faint", "bg"],
  ["text-faint", "surface"],
  ["text-faint", "surface-2"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent", "accent-soft"],
  ["on-accent", "accent-solid"],
  ["down", "surface"],
  ["down", "down-soft"],
  ["danger", "surface"],
  ["danger", "danger-soft"],
];

describe("design tokens", () => {
  for (const theme of ["light", "dark"]) {
    it.each(PAIRS)(`${theme}: %s on %s meets AA contrast`, (fg, bg) => {
      const values = tokens(theme);
      expect(contrast(values[fg], values[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the system dark block identical to the dark theme", () => {
    expect(tokens("system-dark")).toEqual(tokens("dark"));
  });

  it("defines the same tokens in both themes", () => {
    expect(Object.keys(tokens("dark")).sort()).toEqual(
      Object.keys(tokens("light")).sort(),
    );
  });
});

describe("tints", () => {
  const ACCENT_PAIRS = PAIRS.filter(([fg, bg]) => fg.includes("accent") || bg.includes("accent"));

  it("leave orange to the themes, which hold its colors", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(tokens(scheme)).toMatchObject(TINT_COLORS[DEFAULT_TINT][scheme]);
    }
  });

  for (const tint of TINTS.filter((name) => name !== DEFAULT_TINT)) {
    it(`${tint}: app.css holds app/lib/tint.ts's colors, the system dark block the dark one's`, () => {
      expect(tokens(`${tint}:light`, "tint")).toEqual(TINT_COLORS[tint].light);
      expect(tokens(`${tint}:dark`, "tint")).toEqual(TINT_COLORS[tint].dark);
      expect(tokens(`${tint}:system-dark`, "tint")).toEqual(TINT_COLORS[tint].dark);
    });

    for (const scheme of ["light", "dark"] as const) {
      it.each(ACCENT_PAIRS)(`${tint}, ${scheme}: %s on %s meets AA contrast`, (fg, bg) => {
        const values = { ...tokens(scheme), ...TINT_COLORS[tint][scheme] } as Record<string, string>;
        expect(contrast(values[fg]!, values[bg]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("generatedAvatar", () => {
  it.each(AVATAR_COLORS)("keeps white text readable on %s", (color) => {
    expect(contrast("#ffffff", color)).toBeGreaterThanOrEqual(4.5);
  });

  it("derives the color from the user ID, not the username", () => {
    const before = generatedAvatar("user_1", "quiet_otter_482");
    const after = generatedAvatar("user_1", "renamed");
    expect(after.color).toBe(before.color);
    expect(before.letter).toBe("Q");
    expect(after.letter).toBe("R");
  });

  it("spreads users across the palette", () => {
    const colors = new Set(
      Array.from({ length: 200 }, (_, n) => generatedAvatar(`u${n}`, "a").color),
    );
    expect(colors.size).toBe(AVATAR_COLORS.length);
  });
});

describe("formatting", () => {
  it("formats counts compactly", () => {
    expect([0, 7, 999, 1000, 1234, 9999, 12_345, 1_250_000, -5, -1500].map(formatCount)).toEqual(
      ["0", "7", "999", "1.0k", "1.2k", "9.9k", "12k", "1.2m", "-5", "-1.5k"],
    );
  });

  it("formats ages", () => {
    const now = 1_000_000_000;
    const ages = [5, 90, 3 * 3600, 2 * 86_400, 45 * 86_400, 800 * 86_400];
    expect(ages.map((age) => formatAge(now - age, now))).toEqual(
      ["now", "1m", "3h", "2d", "1mo", "2y"],
    );
    // After a verb, "saved just now", never "saved now ago".
    expect([5, 3 * 3600].map((age) => formatAgo(now - age, now))).toEqual(["just now", "3h ago"]);
  });

  it("formats waits, rounding up to whole minutes", () => {
    expect([30, 60, 61, 3599, 3600, 5 * 3600 + 12 * 60].map(formatWait)).toEqual(
      ["30 s", "1 min", "2 min", "1 h", "1 h", "5 h 12 min"],
    );
  });
});

describe("theme cookie", () => {
  it("reads a remembered theme and ignores anything else", () => {
    expect(readTheme("a=1; theme=dark; b=2")).toBe("dark");
    expect(readTheme("theme=light")).toBe("light");
    expect(readTheme("theme=neon")).toBe("system");
    expect(readTheme("mytheme=dark")).toBe("system");
    expect(readTheme(null)).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });

  it("writes a host-only cookie", () => {
    const cookie = themeCookie("dark", true);
    expect(cookie).toBe("theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    expect(cookie).not.toMatch(/domain/i);
    expect(themeCookie("light", false)).not.toContain("Secure");
  });
});

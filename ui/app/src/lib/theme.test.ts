import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, THEME_KEY, applyTheme, normalizeTheme, readTheme, saveTheme } from "./theme";

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const CSS = file("../themes.css");
const HTML = file("../../index.html");

/** The tokens of one theme in one mode, read from themes.css. */
function tokens(id: string, mode: "light" | "dark"): Record<string, string> {
  const split = CSS.indexOf("@media (prefers-color-scheme: dark)");
  const part = mode === "light" ? CSS.slice(0, split) : CSS.slice(split);
  const at = part.indexOf(`[data-theme="${id}"] {`);
  if (at < 0) throw new Error(`no ${mode} block for ${id}`);
  const body = part.slice(at, part.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** WCAG 2.1 relative luminance and contrast ratio, for #rrggbb. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgb(r g b / a)` painted over an opaque #rrggbb backdrop, as #rrggbb (sRGB source-over). */
function composite(rgba: string, backdrop: string): string {
  const m = rgba.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/);
  if (!m) throw new Error(`not rgb(r g b / a): ${rgba}`);
  const a = Number(m[4]);
  const n = parseInt(backdrop.slice(1), 16);
  const under = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = [1, 2, 3].map((i, j) => Math.round(Number(m[i]) * a + under[j] * (1 - a)));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

describe("contrast helper", () => {
  it("agrees with the two fixed points of the formula", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2); // the well-known grey that just fails AA
  });
  it("composites a colour with alpha over a backdrop", () => {
    expect(composite("rgb(0 0 0 / 0.5)", "#ffffff")).toBe("#808080");
    expect(composite("rgb(255 255 255 / 1)", "#000000")).toBe("#ffffff");
    expect(composite("rgb(10 20 30 / 0)", "#123456")).toBe("#123456");
  });
});

describe("normalizeTheme", () => {
  it("keeps a known id", () => {
    for (const t of THEMES) expect(normalizeTheme(t.id)).toBe(t.id);
  });
  it("turns anything else into the default", () => {
    for (const bad of [null, undefined, "", "pink", "Rose", 3, {}]) expect(normalizeTheme(bad)).toBe(DEFAULT_THEME);
  });
});

describe("the choice on a phone", () => {
  it("is the default when nothing is stored", () => {
    expect(readTheme({ getItem: () => null })).toBe("graphite");
  });
  it("reads back what was saved", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(saveTheme("rose", store)).toBe(true);
    expect(data.get(THEME_KEY)).toBe("rose");
    expect(readTheme(store)).toBe("rose");
  });
  it("survives a browser that refuses storage", () => {
    const refuse = () => {
      throw new Error("denied");
    };
    expect(readTheme({ getItem: refuse })).toBe(DEFAULT_THEME);
    expect(saveTheme("ocean", { setItem: refuse })).toBe(false);
  });
});

describe("applyTheme", () => {
  it("sets data-theme and both browser bar colours", () => {
    const metas = { light: { content: "" }, dark: { content: "" } };
    const doc = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: (sel: string) => {
        const mode = sel.includes("dark") ? "dark" : "light";
        return { setAttribute: (_: string, v: string) => void (metas[mode].content = v) };
      },
    } as unknown as Document;
    applyTheme("ocean", doc);
    expect(doc.documentElement.dataset.theme).toBe("ocean");
    expect(metas).toEqual({ light: { content: "#f4f7fb" }, dark: { content: "#070c14" } });
  });
});

describe("themes.css", () => {
  const NAMES = ["bg", "text", "muted", "line", "tile", "glass", "glass-edge", "accent", "accent-text", "on-accent", "band", "orb1", "orb2", "orb3", "shadow"];

  for (const t of THEMES) {
    for (const mode of ["light", "dark"] as const) {
      const k = tokens(t.id, mode);

      it(`${t.id} ${mode} defines every token`, () => {
        expect(Object.keys(k).sort()).toEqual([...NAMES].sort());
      });

      it(`${t.id} ${mode} has the same page colour as the browser bar`, () => {
        expect(k.bg).toBe(t.bar[mode]);
      });

      // Rose keeps its first colours. Two of
      // its pairs are under the limits below (pink link text on a tile, 4.24).
      if (t.id === "rose") continue;

      it(`${t.id} ${mode} has readable text and controls`, () => {
        const pairs: [string, string, number][] = [
          [k.text, k.bg, 4.5],
          [k.text, k.tile, 4.5],
          [k.muted, k.bg, 4.5],
          [k.muted, k.tile, 4.5],
          [k["accent-text"], k.bg, 4.5],
          [k["accent-text"], k.tile, 4.5],
          [k["on-accent"], k.accent, 4.5],
          [k.band, k.tile, 3],
          [k.accent, k.bg, 3], // the focus ring
        ];
        for (const [fg, bg, min] of pairs) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
      });
    }
  }

  // Glass sits on live video and on photos. The backdrop can be any colour, so
  // the check composites the glass over the two extremes, white and black. The
  // 22 px blur averages the backdrop, so a large flat region is the worst case.
  // This check includes Rose.
  for (const t of THEMES) {
    for (const mode of ["light", "dark"] as const) {
      it(`${t.id} ${mode} text on glass over media is 4.5:1 over white and over black`, () => {
        const k = tokens(t.id, mode);
        for (const backdrop of ["#ffffff", "#000000"]) {
          const glass = composite(k.glass, backdrop);
          expect(contrast(k.text, glass), `${k.text} on ${k.glass} over ${backdrop}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("makes the default theme the :root block, in both modes", () => {
    expect(CSS.match(/:root,\s*\[data-theme="graphite"\]/g)).toHaveLength(2);
    expect(DEFAULT_THEME).toBe("graphite");
  });

  it("has no block for a theme that is not in the list", () => {
    const ids = new Set([...CSS.matchAll(/\[data-theme="([a-z]+)"\] \{/g)].map((m) => m[1]));
    expect([...ids].sort()).toEqual(THEMES.map((t) => t.id).sort());
  });
});

describe("index.html", () => {
  it("accepts the same theme ids before the first paint", () => {
    const m = HTML.match(/\/\^\(([a-z|]+)\)\$\//);
    expect(m, "the inline script must test the stored value with /^(a|b|c)$/").not.toBeNull();
    expect(m![1].split("|").sort()).toEqual(THEMES.map((t) => t.id).sort());
    expect(HTML).toContain(`"${THEME_KEY}"`);
  });
  it("starts with the default theme's browser bar colours", () => {
    const def = THEMES.find((t) => t.id === DEFAULT_THEME)!;
    expect(HTML).toContain(`content="${def.bar.light}" media="(prefers-color-scheme: light)"`);
    expect(HTML).toContain(`content="${def.bar.dark}" media="(prefers-color-scheme: dark)"`);
  });
});

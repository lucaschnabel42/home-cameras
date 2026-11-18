// The colour theme of the app, chosen on each phone.
//
// The colours are in src/themes.css. This file holds the list of themes, the
// choice kept in localStorage, and the two things the page needs from a
// choice: data-theme on <html>, and the browser bar colour.
//
// index.html sets data-theme before the first paint, with its own copy of the
// ids. theme.test.ts fails when that copy, this list, and themes.css disagree.
//
// What this does not do: it does not choose light or dark. That follows the
// phone (prefers-color-scheme). It does not sync a choice between phones.

export const THEMES = [
  { id: "graphite", name: "Graphite", note: "Neutral grey", bar: { light: "#f6f6f7", dark: "#0c0d0f" } },
  { id: "ocean", name: "Ocean", note: "Blue", bar: { light: "#f4f7fb", dark: "#070c14" } },
  { id: "sand", name: "Sand", note: "Warm, with terracotta", bar: { light: "#f8f4ee", dark: "#12100d" } },
  { id: "rose", name: "Rose", note: "Pink by day, purple at night", bar: { light: "#faf9fb", dark: "#0b0a0f" } },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** A phone that has made no choice gets this one. */
export const DEFAULT_THEME: ThemeId = "graphite";

export const THEME_KEY = "cam.theme";

/** A stored or foreign value as a theme id; anything unknown is the default. */
export function normalizeTheme(value: unknown): ThemeId {
  return THEMES.find((t) => t.id === value)?.id ?? DEFAULT_THEME;
}

/** The choice on this phone. Private browsing can refuse storage; that reads as no choice. */
export function readTheme(store?: Pick<Storage, "getItem">): ThemeId {
  try {
    return normalizeTheme((store ?? localStorage).getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Keep the choice on this phone. Returns false when the browser refused to store it. */
export function saveTheme(id: ThemeId, store?: Pick<Storage, "setItem">): boolean {
  try {
    (store ?? localStorage).setItem(THEME_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/** Show a theme now: data-theme on <html>, and the browser bar colour for each mode. */
export function applyTheme(id: ThemeId, doc: Document = document): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  doc.documentElement.dataset.theme = theme.id;
  for (const mode of ["light", "dark"] as const) {
    doc
      .querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${mode})"]`)
      ?.setAttribute("content", theme.bar[mode]);
  }
}

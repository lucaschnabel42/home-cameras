// Export name tag shared with exporter/export_clips.py format_name().
// Frigate's Export.name column is max_length=100, so keys are one letter.
export type ClipKind = "event" | "saved";

export interface ClipTag {
  kind: ClipKind;
  camera: string;
  start: number;
  end: number;
  labels: string[];
  /** Real file length in seconds, added by the exporter once the file checks out. */
  duration?: number;
}

const PREFIX = "wc1";

export function formatClipName(t: ClipTag): string {
  const k = t.kind === "event" ? "e" : "s";
  return `${PREFIX};k=${k};c=${t.camera};s=${Math.round(t.start)};e=${Math.round(t.end)};l=${t.labels.join(",")}`;
}

export function parseClipName(name: string): ClipTag | null {
  const parts = name.split(";");
  if (parts[0] !== PREFIX) return null;
  const f: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i < 1) return null;
    f[p.slice(0, i)] = p.slice(i + 1);
  }
  const kind: ClipKind | null = f.k === "e" ? "event" : f.k === "s" ? "saved" : null;
  if (!kind || !f.c || !f.s || !f.e) return null;
  const start = Number(f.s);
  const end = Number(f.e);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const tag: ClipTag = { kind, camera: f.c, start, end, labels: f.l ? f.l.split(",").filter(Boolean) : [] };
  const d = Number(f.d);
  if (f.d && Number.isFinite(d) && d > 0) tag.duration = d;
  return tag;
}

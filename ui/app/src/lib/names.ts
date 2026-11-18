// The names of the cameras and the groups of cameras, as cam-helper keeps
// them (helper/names.py, GET and POST /helper/names). This module is pure:
// it reads, checks and edits the document. It does not fetch or save it
// (lib/helper.ts does), and it does not keep it (hooks/useNames.ts does).
//
// The Frigate key (camera.name) never changes. A name changes only the
// title on the screen.
import { cameraTitle, type CameraInfo } from "./frigate";

export interface CameraNames {
  /** The name the user gave. Absent: the app shows the derived name. */
  name?: string;
  /** The id of the group of the camera. A camera is in one group at most. */
  group?: string;
}

export interface Group {
  id: string;
  name: string;
}

export interface NamesDoc {
  /** The revision the client read. cam-helper refuses a save with an old rev (409). */
  rev: number;
  cameras: Record<string, CameraNames>;
  /** The order of the groups is the order on the screen. */
  groups: Group[];
}

export const EMPTY_NAMES: NamesDoc = { rev: 0, cameras: {}, groups: [] };

/**
 * True when a document that was read from cam-helper must replace the one
 * the app holds. The revision only goes up, so a lower or equal revision is
 * an old answer. Not modelled: a names file that was deleted on the server
 * starts again at 0; the app then shows its old document until the next
 * edit, which gets a 409 and the stored document.
 */
export const isNewer = (held: NamesDoc | null, read: NamesDoc): boolean => !held || read.rev > held.rev;

/** The longest name, in characters. */
export const NAME_MAX = 32;
/** cam-helper refuses a document with more groups (helper/names.py). */
export const MAX_GROUPS = 24;
const GROUP_ID = /^[a-z0-9]{1,12}$/;
// \p{Nd}, a decimal digit, as in helper/names.py: "²" and "Ⅷ" are not digits here.
const FIRST = /^[\p{L}\p{Nd}]$/u;
const OTHER = /^[\p{L}\p{Nd} '’\-&.]$/u;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The document from an answer of cam-helper. A field of the wrong type takes
 * its default, a bad entry is dropped, and a camera that names a group that
 * does not exist is in no group.
 */
export function parseNames(raw: unknown): NamesDoc {
  if (!isObject(raw)) return EMPTY_NAMES;
  const rev = typeof raw.rev === "number" && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  const groups: Group[] = [];
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (isObject(g) && typeof g.id === "string" && typeof g.name === "string" && !groups.some((x) => x.id === g.id)) {
        groups.push({ id: g.id, name: g.name });
      }
    }
  }
  const ids = new Set(groups.map((g) => g.id));
  const cameras: Record<string, CameraNames> = {};
  if (isObject(raw.cameras)) {
    for (const [key, v] of Object.entries(raw.cameras)) {
      if (!isObject(v)) continue;
      const entry = tidy({
        name: typeof v.name === "string" ? v.name : undefined,
        group: typeof v.group === "string" && ids.has(v.group) ? v.group : undefined,
      });
      if (entry) cameras[key] = entry;
    }
  }
  return { rev, cameras, groups };
}

/** The entry with its fields in contract order, or null when it holds nothing. */
function tidy(e: CameraNames): CameraNames | null {
  const out: CameraNames = {};
  if (e.name) out.name = e.name;
  if (e.group) out.group = e.group;
  return out.name || out.group ? out : null;
}

/** The title of a camera on the screen: the user's name, else the derived name. */
export function titleOf(doc: NamesDoc, key: string): string {
  return doc.cameras[key]?.name || cameraTitle(key);
}

/** The camera list with the user's titles. The keys stay. */
export function applyNames(cams: CameraInfo[], doc: NamesDoc): CameraInfo[] {
  return cams.map((c) => {
    const title = titleOf(doc, c.name);
    return title === c.title ? c : { ...c, title };
  });
}

export interface Section {
  /** The group id, or null for the cameras in no group. */
  id: string | null;
  name: string;
  cameras: CameraInfo[];
}

/**
 * The cameras by group: the groups in their order, each with its cameras in
 * config order, then "Other cameras" for the cameras in no group. A group
 * with no camera is absent, and so is an empty "Other cameras".
 */
export function groupSections(cams: CameraInfo[], doc: NamesDoc): Section[] {
  const ids = new Set(doc.groups.map((g) => g.id));
  const groupOf = (c: CameraInfo) => {
    const g = doc.cameras[c.name]?.group;
    return g && ids.has(g) ? g : null;
  };
  const out: Section[] = doc.groups
    .map((g) => ({ id: g.id, name: g.name, cameras: cams.filter((c) => groupOf(c) === g.id) }))
    .filter((s) => s.cameras.length > 0);
  const other = cams.filter((c) => groupOf(c) === null);
  if (other.length > 0) out.push({ id: null, name: "Other cameras", cameras: other });
  return out;
}

/** White space trimmed and collapsed to one space. */
export const cleanName = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Why a name breaks the rule, or null when it is good. The rule keeps a name
 * safe in a push message and in a model prompt. `empty`: an empty name is
 * good (a camera with no name). `taken`: the names of the other groups.
 */
export function nameProblem(raw: string, opts: { empty?: boolean; taken?: string[] } = {}): string | null {
  // A line break or a tab in the typed text is refused, not collapsed: the
  // text field holds one line, so such a character comes from a paste.
  if (/\p{Cc}/u.test(raw)) return "Use one line with no tabs.";
  const name = cleanName(raw);
  const chars = [...name];
  if (chars.length === 0) return opts.empty ? null : "Type a name.";
  if (chars.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`;
  if (!FIRST.test(chars[0])) return "Start with a letter or a digit.";
  if (!chars.every((c) => OTHER.test(c))) return "Use only letters, digits, spaces, and ' - & .";
  const lower = name.toLowerCase();
  if (opts.taken?.some((t) => t.toLowerCase() === lower)) return "Another group has this name.";
  return null;
}

/** Give a camera a name. An empty name removes the name. */
export function renameCamera(doc: NamesDoc, key: string, raw: string): NamesDoc {
  return withCamera(doc, key, { ...doc.cameras[key], name: cleanName(raw) || undefined });
}

/** Put a camera in a group, or in no group (null). An unknown group changes nothing. */
export function setGroup(doc: NamesDoc, key: string, id: string | null): NamesDoc {
  if (id !== null && !doc.groups.some((g) => g.id === id)) return doc;
  return withCamera(doc, key, { ...doc.cameras[key], group: id ?? undefined });
}

function withCamera(doc: NamesDoc, key: string, entry: CameraNames): NamesDoc {
  const cameras = { ...doc.cameras };
  const e = tidy(entry);
  if (e) cameras[key] = e;
  else delete cameras[key];
  return { ...doc, cameras };
}

/** "g" and the smallest number that no group of the document has. */
export function newGroupId(doc: NamesDoc): string {
  const ids = new Set(doc.groups.map((g) => g.id));
  for (let n = 1; ; n++) {
    const id = `g${n}`;
    if (!ids.has(id) && GROUP_ID.test(id)) return id;
  }
}

/** Add a group at the end, named "Group 1", "Group 2", ... with the first free name. */
export function addGroup(doc: NamesDoc): { doc: NamesDoc; id: string } {
  const id = newGroupId(doc);
  const taken = new Set(doc.groups.map((g) => g.name.toLowerCase()));
  let n = 1;
  while (taken.has(`group ${n}`)) n++;
  return { doc: { ...doc, groups: [...doc.groups, { id, name: `Group ${n}` }] }, id };
}

export function renameGroup(doc: NamesDoc, id: string, raw: string): NamesDoc {
  return { ...doc, groups: doc.groups.map((g) => (g.id === id ? { ...g, name: cleanName(raw) } : g)) };
}

/** Move a group up (-1) or down (+1). At an end, the same document comes back. */
export function moveGroup(doc: NamesDoc, id: string, delta: -1 | 1): NamesDoc {
  const i = doc.groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.groups.length) return doc;
  const groups = [...doc.groups];
  [groups[i], groups[j]] = [groups[j], groups[i]];
  return { ...doc, groups };
}

/** Remove a group. Its cameras go to no group; no reference to the id stays. */
export function removeGroup(doc: NamesDoc, id: string): NamesDoc {
  let out: NamesDoc = { ...doc, groups: doc.groups.filter((g) => g.id !== id) };
  for (const [key, e] of Object.entries(doc.cameras)) {
    if (e.group === id) out = withCamera(out, key, { ...e, group: undefined });
  }
  return out;
}

// The install's own settings, from cam-helper: GET /helper/config.
//
// The helper is optional. When the call fails, or the answer has an unknown
// shape, the app uses DEFAULT_CONFIG: no pet, so the pet day card is absent and
// the label "dog" reads "Dog".

/** The pet of this home, as the install sets it (PET_NAME, PET_CAMERA). */
export interface Pet {
  name: string;
  /** The Frigate camera that the pet day pictures come from. */
  camera: string;
  /** The Frigate label of the pet. */
  label: "dog" | "cat";
}

export interface AppConfig {
  pet: Pet | null;
  features: {
    /** The local vision model writes a title and a summary for each event. */
    summaries: boolean;
    /** cam-helper makes a pet day page each day. */
    petDay: boolean;
  };
}

export const DEFAULT_CONFIG: AppConfig = { pet: null, features: { summaries: false, petDay: false } };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Reads the answer of /helper/config. A field of the wrong type takes its
 * default value, so a helper of another version cannot break the app.
 */
export function parseAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const r = raw as { pet?: unknown; features?: unknown };
  let pet: Pet | null = null;
  if (r.pet && typeof r.pet === "object") {
    const p = r.pet as Record<string, unknown>;
    const name = text(p.name);
    const camera = text(p.camera);
    const label = p.label === "cat" ? "cat" : p.label === "dog" ? "dog" : null;
    if (name && camera && label) pet = { name, camera, label };
  }
  const f = (r.features && typeof r.features === "object" ? r.features : {}) as Record<string, unknown>;
  return {
    pet,
    features: {
      summaries: f.summaries === true,
      // A pet day needs a pet.
      petDay: f.petDay === true && pet !== null,
    },
  };
}

/** The settings, or DEFAULT_CONFIG when cam-helper does not answer. Never throws. */
export async function getAppConfig(): Promise<AppConfig> {
  try {
    const r = await fetch("/helper/config", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return DEFAULT_CONFIG;
    return parseAppConfig(await r.json());
  } catch {
    return DEFAULT_CONFIG;
  }
}

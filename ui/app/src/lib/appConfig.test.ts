import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, getAppConfig, parseAppConfig } from "./appConfig";

describe("parseAppConfig", () => {
  it("reads a pet and the features", () => {
    const c = parseAppConfig({ pet: { name: "Rex", camera: "living_room_cam", label: "dog" }, features: { summaries: true, petDay: true } });
    expect(c).toEqual({ pet: { name: "Rex", camera: "living_room_cam", label: "dog" }, features: { summaries: true, petDay: true } });
  });
  it("has no pet when the helper says null", () => {
    expect(parseAppConfig({ pet: null, features: { summaries: false, petDay: false } })).toEqual(DEFAULT_CONFIG);
  });
  it("drops a pet with a missing name, camera or an unknown label", () => {
    expect(parseAppConfig({ pet: { name: "", camera: "c", label: "dog" } }).pet).toBeNull();
    expect(parseAppConfig({ pet: { name: "Rex", label: "dog" } }).pet).toBeNull();
    expect(parseAppConfig({ pet: { name: "Rex", camera: "c", label: "horse" } }).pet).toBeNull();
  });
  it("turns the pet day off when there is no pet", () => {
    expect(parseAppConfig({ pet: null, features: { petDay: true } }).features.petDay).toBe(false);
  });
  it("gives the defaults for an answer of an unknown shape", () => {
    expect(parseAppConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseAppConfig("hello")).toEqual(DEFAULT_CONFIG);
    expect(parseAppConfig({ features: { summaries: "yes" } })).toEqual(DEFAULT_CONFIG);
  });
});

describe("getAppConfig", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("gives the defaults when the call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await getAppConfig()).toEqual(DEFAULT_CONFIG);
  });
  it("gives the defaults for a 404 (a helper that has no /config route)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    expect(await getAppConfig()).toEqual(DEFAULT_CONFIG);
  });
  it("reads the pet from a good answer", async () => {
    const body = { pet: { name: "Mia", camera: "kitchen_cam", label: "cat" }, features: { summaries: false, petDay: true } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    expect((await getAppConfig()).pet?.name).toBe("Mia");
  });
});

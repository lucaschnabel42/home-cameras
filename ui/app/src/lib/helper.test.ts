import { afterEach, describe, expect, it, vi } from "vitest";
import { getNames, saveNames } from "./helper";
import type { NamesDoc } from "./names";

const FIRST: NamesDoc = {
  rev: 0,
  cameras: { front_yard: { name: "Front Door", group: "g1" }, kitchen_cam: { group: "g2" }, porch: { name: "Emma's room" } },
  groups: [
    { id: "g1", name: "Outside" },
    { id: "g2", name: "Inside" },
  ],
};
const BODY =
  '{"rev": 0, "cameras": {"front_yard": {"name": "Front Door", "group": "g1"}, "kitchen_cam": {"group": "g2"}, "porch": {"name": "Emma\'s room"}}, "groups": [{"id": "g1", "name": "Outside"}, {"id": "g2", "name": "Inside"}]}';

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("saveNames", () => {
  it("sends exactly the document of a first save", async () => {
    const fetch = answer(200, { ...FIRST, rev: 1 });
    await saveNames(FIRST);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/helper/names");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(BODY));
    expect(init?.body).toBe(JSON.stringify(JSON.parse(BODY)));
  });
  it("reads a 200 answer as the stored document", async () => {
    answer(200, { ...FIRST, rev: 1 });
    expect(await saveNames(FIRST)).toEqual({ kind: "saved", names: { ...FIRST, rev: 1 } });
  });
  it("reads a 409 answer as a conflict with the stored document", async () => {
    const stored = { rev: 5, cameras: { porch: { name: "Porch" } }, groups: [] };
    answer(409, { error: "The names changed on another device.", names: stored });
    expect(await saveNames(FIRST)).toEqual({ kind: "conflict", error: "The names changed on another device.", names: stored });
  });
  it("reads a 409 answer with no document as a failure", async () => {
    answer(409, { error: "The names changed on another device." });
    expect(await saveNames(FIRST)).toEqual({ kind: "failed", error: "The names changed on another device." });
  });
  it("reads a 400 answer as a refusal with the reason", async () => {
    answer(400, { error: "A group name is used two times." });
    expect(await saveNames(FIRST)).toEqual({ kind: "failed", error: "A group name is used two times." });
  });
  it("reads no answer as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await saveNames(FIRST)).kind).toBe("failed");
  });
});

describe("getNames", () => {
  it("parses the document", async () => {
    answer(200, { rev: 2, cameras: { a: { name: "Den" } }, groups: "bad" });
    expect(await getNames()).toEqual({ rev: 2, cameras: { a: { name: "Den" } }, groups: [] });
  });
  it("fails when cam-helper does not answer", async () => {
    answer(502, {});
    await expect(getNames()).rejects.toThrow();
  });
});

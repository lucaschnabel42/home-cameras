import { describe, expect, it } from "vitest";
import { firstParameterSets, repairInit, spsInfo } from "./mp4Init";
import { INIT_B64, SEGMENT_HEAD_B64 } from "./fixtures/liveInit";

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const INIT = bytes(INIT_B64);
const SEGMENT = bytes(SEGMENT_HEAD_B64);

/** The SPS and PPS of the Wyze Cam V4, read from the capture with a separate script. */
const REAL_SPS = "27640032ad00ce802800b5a6a020203e000003000200000300506480015f900020f5bfff8140";
const PLACEHOLDER_SPS = "6742000af841a2";

type Box = { type: string; start: number; size: number };

/** Every box in [start, end). Throws if the sizes do not fill the range exactly. */
function walk(d: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p < end) {
    const size = view.getUint32(p);
    const type = String.fromCharCode(...d.subarray(p + 4, p + 8));
    if (size < 8 || p + size > end) throw new Error(`box ${type} at ${p} has size ${size}, range ends at ${end}`);
    out.push({ type, start: p, size });
    p += size;
  }
  return out;
}

/** Follows a path of box types. "trak" takes the first one; stsd and avc1 skip their fixed fields. */
function descend(d: Uint8Array, path: string[]): Box {
  let range = { start: 0, end: d.length };
  let box: Box | undefined;
  for (const type of path) {
    box = walk(d, range.start, range.end).find((b) => b.type === type);
    if (!box) throw new Error(`no ${type}`);
    const skip = type === "stsd" ? 16 : type === "avc1" ? 86 : 8;
    range = { start: box.start + skip, end: box.start + box.size };
  }
  return box!;
}

const AVCC = ["moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1", "avcC"];

function spsOf(init: Uint8Array): string {
  const box = descend(init, AVCC);
  const p = box.start + 8;
  const len = (init[p + 6] << 8) | init[p + 7];
  return hex(init.subarray(p + 8, p + 8 + len));
}

describe("the capture", () => {
  it("has the placeholder header that Safari cannot decode from", () => {
    expect(spsOf(INIT)).toBe(PLACEHOLDER_SPS);
  });
});

describe("firstParameterSets", () => {
  it("reads the SPS and PPS of the first keyframe", () => {
    const sets = firstParameterSets(SEGMENT)!;
    expect(hex(sets.sps)).toBe(REAL_SPS);
    expect(hex(sets.pps)).toBe("28ee3cb0");
  });
  it("returns null for a segment with no SPS", () => {
    // moof (8 bytes, empty) + mdat with one P-frame NAL of 4 bytes
    const seg = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 16, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 4, 0x41, 1, 2, 3]);
    expect(firstParameterSets(seg)).toBeNull();
  });
  it("returns null for bytes that are not MP4", () => {
    expect(firstParameterSets(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(firstParameterSets(new Uint8Array(64))).toBeNull();
  });
});

describe("spsInfo", () => {
  it("reads the real picture size, profile and level", () => {
    const info = spsInfo(firstParameterSets(SEGMENT)!.sps)!;
    expect(info).toMatchObject({ width: 2560, height: 1440, profile: 100, level: 50, chromaFormat: 1, bitDepthLuma: 8, bitDepthChroma: 8 });
  });
  it("reads the placeholder as 128x96 Baseline", () => {
    const sps = Uint8Array.from(PLACEHOLDER_SPS.match(/../g)!, (h) => parseInt(h, 16));
    expect(spsInfo(sps)).toMatchObject({ width: 128, height: 96, profile: 66 });
  });
  it("returns null for a truncated SPS", () => {
    expect(spsInfo(new Uint8Array([0x67, 0x64]))).toBeNull();
  });
});

describe("repairInit", () => {
  const fixed = repairInit(INIT, SEGMENT)!;

  it("puts the real SPS and PPS in the header", () => {
    expect(fixed).not.toBeNull();
    expect(spsOf(fixed.init)).toBe(REAL_SPS);
    const box = descend(fixed.init, AVCC);
    const p = box.start + 8;
    // version, profile, compatibility, level, 4-byte NAL lengths, one SPS
    expect(Array.from(fixed.init.subarray(p, p + 6))).toEqual([1, 0x64, 0x00, 0x32, 0xff, 0xe1]);
    const spsLen = REAL_SPS.length / 2;
    const afterSps = p + 8 + spsLen;
    expect(fixed.init[afterSps]).toBe(1); // one PPS
    expect(hex(fixed.init.subarray(afterSps + 3, afterSps + 7))).toBe("28ee3cb0");
    // High profile: chroma format 4:2:0, 8-bit luma and chroma, no SPS extension
    expect(Array.from(fixed.init.subarray(afterSps + 7, afterSps + 11))).toEqual([0xfd, 0xf8, 0xf8, 0]);
    expect(afterSps + 11).toBe(box.start + box.size);
  });

  it("names the real codec", () => {
    expect(fixed.codec).toBe("avc1.640032");
  });

  it("keeps every box size exact at every level", () => {
    // walk() throws when a parent's size does not match its children.
    const top = walk(fixed.init, 0, fixed.init.length);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "moov"]);
    for (let i = 1; i <= AVCC.length; i++) descend(fixed.init, AVCC.slice(0, i));
    const moov = descend(fixed.init, ["moov"]);
    expect(walk(fixed.init, moov.start + 8, moov.start + moov.size).map((b) => b.type)).toEqual(["mvhd", "trak", "trak", "mvex"]);
  });

  it("sets the picture size in the sample entry and the track header", () => {
    const view = new DataView(fixed.init.buffer, fixed.init.byteOffset);
    const avc1 = descend(fixed.init, AVCC.slice(0, 7));
    expect([view.getUint16(avc1.start + 32), view.getUint16(avc1.start + 34)]).toEqual([2560, 1440]);
    const tkhd = descend(fixed.init, ["moov", "trak", "tkhd"]);
    const end = tkhd.start + tkhd.size;
    expect([view.getUint32(end - 8) / 65536, view.getUint32(end - 4) / 65536]).toEqual([2560, 1440]);
  });

  it("leaves the audio track and everything after the video track unchanged", () => {
    const tail = (d: Uint8Array) => {
      const moov = descend(d, ["moov"]);
      const kids = walk(d, moov.start + 8, moov.start + moov.size);
      return hex(d.subarray(kids[2].start));
    };
    expect(tail(fixed.init)).toBe(tail(INIT));
  });

  it("does not change its input", () => {
    expect(spsOf(INIT)).toBe(PLACEHOLDER_SPS);
    expect(INIT.length).toBe(1112);
  });

  it("returns null when the header already agrees with the keyframe", () => {
    expect(repairInit(fixed.init, SEGMENT)).toBeNull();
  });

  it("returns null when it cannot parse the header or the segment", () => {
    expect(repairInit(new Uint8Array(40), SEGMENT)).toBeNull();
    expect(repairInit(INIT.subarray(0, 300), SEGMENT)).toBeNull();
    expect(repairInit(INIT, new Uint8Array(40))).toBeNull();
  });
});

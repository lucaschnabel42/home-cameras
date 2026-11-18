// Repairs the header (the "init segment") of go2rtc's live MP4 stream.
//
// go2rtc builds the header from the stream's SDP. The SDP of the Wyze bridge
// carries no SPS and PPS (no sprop-parameter-sets), so go2rtc writes a
// placeholder: Baseline profile, 128x96 (go2rtc pkg/mp4/muxer.go, "some dummy
// SPS and PPS"). The real SPS and PPS arrive inside each keyframe. Chrome and
// Firefox read them there. Safari sets up its decoder from the header and
// fails on the first keyframe. Without the repair, every iPhone session ends
// 1 to 2 s after it opens, at the first keyframe, and the tile says
// "Connecting".
//
// repairInit copies the SPS and PPS of the first keyframe into the header and
// corrects the picture size there.
//
// What it does not do:
// - It does not repair an H.265 stream (hvc1), or a header with more than one
//   H.264 track. It returns null, and the caller sends the bytes unchanged.
// - It reads only the first media segment. go2rtc starts every stream on a
//   keyframe, so that segment holds the SPS and PPS.
// - It does not follow a later change of the SPS inside one stream.

type Box = { type: string; start: number; size: number };

const u32 = (d: Uint8Array, p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;

/** The boxes in [start, end). A box that runs past `end` is cut to fit; a bad size ends the list. */
function boxes(d: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size = u32(d, p);
    if (size < 8) break; // 0 (to end of file) and 1 (64-bit size) do not occur in go2rtc's output
    const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
    out.push({ type, start: p, size: Math.min(size, end - p) });
    p += size;
  }
  return out;
}

/** The SPS and PPS of the first keyframe in a media segment (moof + mdat, 4-byte NAL lengths). */
export function firstParameterSets(segment: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  const mdat = boxes(segment, 0, segment.length).find((b) => b.type === "mdat");
  if (!mdat) return null;
  const end = mdat.start + mdat.size;
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let p = mdat.start + 8;
  while (p + 5 <= end && !(sps && pps)) {
    const len = u32(segment, p);
    if (len === 0 || p + 4 + len > end) break;
    const type = segment[p + 4] & 0x1f;
    if (type === 7 && !sps) sps = segment.subarray(p + 4, p + 4 + len);
    if (type === 8 && !pps) pps = segment.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  return sps && pps ? { sps, pps } : null;
}

export interface SpsInfo {
  profile: number;
  level: number;
  width: number;
  height: number;
  /** chroma_format_idc: 1 is 4:2:0. */
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
}

/** Profiles whose SPS carries the chroma format and the bit depths (H.264 7.3.2.1.1). */
const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/** Parses an H.264 SPS NAL unit (with its one-byte NAL header). Null if the bytes end early. */
export function spsInfo(sps: Uint8Array): SpsInfo | null {
  // Remove the emulation prevention bytes: 00 00 03 -> 00 00.
  const d: number[] = [];
  for (let i = 1; i < sps.length; i++) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    d.push(sps[i]);
  }
  let bit = 0;
  const total = d.length * 8;
  const u = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (bit >= total) throw new RangeError("SPS ends early");
      v = v * 2 + ((d[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const ue = (): number => {
    let zeros = 0;
    while (u(1) === 0) {
      if (++zeros > 31) throw new RangeError("bad Exp-Golomb code");
    }
    return 2 ** zeros - 1 + (zeros ? u(zeros) : 0);
  };
  const se = (): number => {
    const k = ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  };

  try {
    const profile = u(8);
    u(8); // constraint flags
    const level = u(8);
    ue(); // seq_parameter_set_id
    let chromaFormat = 1;
    let separatePlanes = 0;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    if (HIGH_PROFILES.includes(profile)) {
      chromaFormat = ue();
      if (chromaFormat === 3) separatePlanes = u(1);
      bitDepthLuma = ue() + 8;
      bitDepthChroma = ue() + 8;
      u(1); // qpprime_y_zero_transform_bypass_flag
      if (u(1)) {
        // seq_scaling_matrix_present_flag: skip each list
        for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
          if (!u(1)) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    ue(); // log2_max_frame_num_minus4
    const pocType = ue();
    if (pocType === 0) ue();
    else if (pocType === 1) {
      u(1);
      se();
      se();
      const n = ue();
      for (let i = 0; i < n; i++) se();
    }
    ue(); // max_num_ref_frames
    u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = ue() + 1;
    const heightMapUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) u(1);
    u(1); // direct_8x8_inference_flag
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    if (u(1)) {
      left = ue();
      right = ue();
      top = ue();
      bottom = ue();
    }
    // Crop units (H.264 Table 6-1 and equations 7-19 to 7-22).
    const mono = chromaFormat === 0 || separatePlanes === 1;
    const cropX = mono ? 1 : chromaFormat === 3 ? 1 : 2;
    const cropY = (mono ? 1 : chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return {
      profile,
      level,
      width: widthMbs * 16 - (left + right) * cropX,
      height: (2 - frameMbsOnly) * heightMapUnits * 16 - (top + bottom) * cropY,
      chromaFormat,
      bitDepthLuma,
      bitDepthChroma,
    };
  } catch {
    return null;
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

/**
 * The header with the SPS and PPS of `segment` (the first media segment), and
 * the codec name for MediaSource. Null when the header needs no repair or when
 * either input cannot be parsed; the caller then uses the header as it is.
 */
export function repairInit(init: Uint8Array, segment: Uint8Array): { init: Uint8Array; codec: string } | null {
  const sets = firstParameterSets(segment);
  if (!sets) return null;
  const info = spsInfo(sets.sps);
  if (!info || info.width <= 0 || info.height <= 0 || info.width > 0xffff || info.height > 0xffff) return null;

  // moov > trak (the one with an avc1 entry) > mdia > minf > stbl > stsd > avc1 > avcC
  const moov = boxes(init, 0, init.length).find((b) => b.type === "moov");
  if (!moov || moov.start + moov.size > init.length) return null;
  const inside = (b: Box, skip = 8) => boxes(init, b.start + skip, b.start + b.size);
  const child = (b: Box | undefined, type: string, skip = 8) => (b ? inside(b, skip).find((x) => x.type === type) : undefined);

  let found: { chain: Box[]; tkhd: Box; avc1: Box; avcC: Box } | null = null;
  for (const trak of inside(moov).filter((b) => b.type === "trak")) {
    const mdia = child(trak, "mdia");
    const minf = child(mdia, "minf");
    const stbl = child(minf, "stbl");
    const stsd = child(stbl, "stsd");
    const avc1 = child(stsd, "avc1", 16); // version and flags, entry count
    const avcC = child(avc1, "avcC", 86); // the fixed fields of a video sample entry
    const tkhd = child(trak, "tkhd");
    if (!mdia || !minf || !stbl || !stsd || !avc1 || !avcC || !tkhd) continue;
    if (found) return null; // two H.264 tracks: not a stream this app plays
    found = { chain: [moov, trak, mdia, minf, stbl, stsd, avc1], tkhd, avc1, avcC };
  }
  if (!found) return null;
  const { chain, tkhd, avc1, avcC } = found;

  // avcC: version, profile, compatibility, level, NAL length size, SPS count, SPS length, SPS ...
  const p = avcC.start + 8;
  if (avcC.size < 8 + 8 || (init[p + 4] & 3) !== 3 || (init[p + 5] & 0x1f) < 1) return null;
  const oldLen = (init[p + 6] << 8) | init[p + 7];
  if (p + 8 + oldLen > avcC.start + avcC.size) return null;
  if (same(init.subarray(p + 8, p + 8 + oldLen), sets.sps)) return null;

  const { sps, pps } = sets;
  // ISO 14496-15: these profiles add the chroma format and the bit depths.
  const ext = [100, 110, 122, 144].includes(info.profile)
    ? [0xfc | info.chromaFormat, 0xf8 | (info.bitDepthLuma - 8), 0xf8 | (info.bitDepthChroma - 8), 0]
    : [];
  const body = [1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps, ...ext];
  const size = 8 + body.length;
  const box = Uint8Array.from([size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, 0x61, 0x76, 0x63, 0x43, ...body]);

  const out = new Uint8Array(init.length - avcC.size + size);
  out.set(init.subarray(0, avcC.start), 0);
  out.set(box, avcC.start);
  out.set(init.subarray(avcC.start + avcC.size), avcC.start + size);

  // Every box that holds the avcC starts before it, so its offset did not move.
  const view = new DataView(out.buffer);
  const delta = size - avcC.size;
  for (const b of chain) view.setUint32(b.start, b.size + delta);
  view.setUint16(avc1.start + 32, info.width);
  view.setUint16(avc1.start + 34, info.height);
  // tkhd ends with width and height as 16.16 fixed point; tkhd comes before mdia.
  if (tkhd.start < avcC.start && tkhd.size >= 16) {
    view.setUint32(tkhd.start + tkhd.size - 8, info.width * 65536);
    view.setUint32(tkhd.start + tkhd.size - 4, info.height * 65536);
  }
  return { init: out, codec: `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}` };
}

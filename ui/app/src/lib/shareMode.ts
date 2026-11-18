// How the clip player hands over a clip file: through the share sheet, or as a
// plain download link.

/**
 * The largest file that Share or Download reads into memory: 150 MB.
 *
 * The share path holds the file twice at its peak (the downloaded parts and
 * the File made from them), so 150 MB costs about 300 MB. iOS gives one
 * Safari page well under 1 GB before it reloads the page, and the page also
 * holds the playing video. A larger file also takes minutes to download
 * before the share sheet can open, and iOS can refuse a share after a long
 * wait. At the measured 147 KB/s of the live exports, 150 MB is about 17 min
 * of clip, so most event clips still share.
 */
export const SHARE_LIMIT_BYTES = 150_000_000;

/**
 * Bytes per second of an export, measured on one recorder: a 6,380 s clip was
 * 940,896,753 bytes. Used only when the size is not known.
 */
export const EXPORT_BYTES_PER_S = 147_500;

export type ShareMode = "share" | "link";

/**
 * "link" when the file is too large to read into memory: the player then
 * offers a plain <a href download> link, which Safari streams to Files.
 * sizeBytes comes from a HEAD request (null when it failed or is not back
 * yet); clipSeconds is the clip length (0 when not known).
 */
export function shareMode(sizeBytes: number | null, clipSeconds: number): ShareMode {
  const size = sizeBytes ?? clipSeconds * EXPORT_BYTES_PER_S;
  return size > SHARE_LIMIT_BYTES ? "link" : "share";
}

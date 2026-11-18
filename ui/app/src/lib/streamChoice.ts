// Which tiles may ask for the clean stream. The clean stream removes the
// damaged frames of the camera, but it costs the server 0.8 of one CPU core
// for each viewer and camera (go2rtc runs one ffmpeg encoder for it). So only
// a screen with few live pictures uses it.

/** A screen with at most this many live tiles may use the clean stream. */
export const CLEAN_MAX_TILES = 2;

export type StreamPlace =
  /** The single camera view: always the clean stream. */
  | { kind: "camera-view" }
  /** A tile of the home grid. `liveTiles` is the count of tiles that play live. */
  | { kind: "home"; liveTiles: number }
  /** A tile of the security wall. `wallCameras` is the count of cameras on the wall. */
  | { kind: "wall"; wallCameras: number };

/** True when a tile in this place asks for the clean stream (when the camera has one). */
export function usesCleanStream(place: StreamPlace): boolean {
  switch (place.kind) {
    case "camera-view":
      return true;
    case "home":
      return place.liveTiles <= CLEAN_MAX_TILES;
    case "wall":
      return place.wallCameras <= CLEAN_MAX_TILES;
  }
}

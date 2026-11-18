// Types for the parts of go2rtc's VideoRTC (video-rtc.js) this app uses.
export class VideoRTC extends HTMLElement {
  video: HTMLVideoElement | null;
  mode: string;
  background: boolean;
  visibilityCheck: boolean;
  visibilityThreshold: number;
  /** Handlers for the JSON messages of the socket, one per mode ("mse"). Set in onopen(). */
  onmessage: Record<string, (msg: { type: string; value: string }) => void> | null;
  /** Handler for the binary messages of the socket (MP4 bytes). Set when the "mse" reply arrives. */
  ondata: ((data: ArrayBuffer) => void) | null;
  set src(value: string);
  oninit(): void;
  /** Plays the video; when the browser refuses sound, mutes it and plays again. */
  play(): void;
  onconnect(): boolean;
  ondisconnect(): void;
  onmse(): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
}

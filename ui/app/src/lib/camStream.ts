// <cam-stream>: go2rtc's VideoRTC with no controls, muted, and drawn with
// object-fit: fill so the box (sized from the camera's real aspect) wins over
// the aspect the MSE stream declares.
//
// VideoRTC adds a document "visibilitychange" listener per element and never
// removes it, so every closed stream stayed in memory with its 2 MB buffer
// (video-rtc.js oninit). This subclass turns that off, runs its own listener,
// and removes it in dispose().
//
// It also repairs the MP4 header before the browser sees it (onmse below, and
// mp4Init.ts for the reason), and reports a video error to the server log.
import { VideoRTC } from "../vendor/video-rtc.js";
import { repairInit } from "./mp4Init";
import { liveReportUrl, shouldReportVideoError, type LiveReportEvent } from "./liveReport";
import type { StreamKind } from "./liveSource";

/**
 * Writes one line about the live view (a fault, or a change of stream) to
 * Frigate's nginx access log, with the stream of the element and the state of
 * its video. `fields` go first, so a report's own value is in `fields`. A phone has no console that anyone reads.
 * Frigate's nginx does not log /api/version or /api/stats, so the report goes
 * to /api/review?after=9999999999, which returns [] and is logged
 * (liveReport.ts). Read the lines with:
 * docker exec frigate grep live_ /dev/shm/logs/nginx/current
 */
export function reportLive(event: LiveReportEvent, el: CamStream, fields: Record<string, string | number> = {}) {
  const v = el.video ?? null;
  const b = v?.buffered;
  const ahead = v && b && b.length ? (b.end(b.length - 1) - v.currentTime).toFixed(2) : "none";
  const url = liveReportUrl(event, el.streamKind, {
    ...fields,
    rs: v?.readyState ?? -1,
    paused: v?.paused ? 1 : 0,
    rate: v?.playbackRate.toFixed(2) ?? 0,
    ahead,
    hidden: document.hidden ? 1 : 0,
  });
  void fetch(url, { credentials: "same-origin" }).catch(() => {});
}

export class CamStream extends VideoRTC {
  /** VideoRTC's socket state (a WebSocket ready state); CLOSED means the app closed it. */
  declare wsState: number;
  /**
   * The stream that this element plays. The reports name it (s=direct or
   * s=clean). LiveVideo sets it when it creates the element.
   */
  streamKind: StreamKind = "direct";

  private readonly onVisibility = () => {
    if (document.hidden) this.disconnectedCallback();
    else if (this.isConnected) this.connectedCallback();
  };

  constructor() {
    super();
    this.visibilityCheck = false;
  }

  oninit() {
    super.oninit();
    const v = this.video!;
    v.controls = false;
    v.muted = true;
    // "fill" for Frigate cameras (box sized from the detect aspect); "contain"
    // for live-only streams, whose shape is not known in advance.
    v.style.objectFit = this.getAttribute("fit") === "contain" ? "contain" : "fill";
    // A phone has no console that anyone reads. Put the browser's own error
    // text in Frigate's nginx access log (see reportLive). VideoRTC closes the
    // socket on this event and connects again after 15 s, so this sends at
    // most one request each 15 s for each stream. The error that a closing
    // stream fires (video.src = "") is not reported (shouldReportVideoError).
    v.addEventListener("error", () => {
      const e = v.error;
      const code = e?.code ?? 0;
      const hasSource = !!v.getAttribute("src") || !!v.srcObject;
      if (!shouldReportVideoError({ code, socketClosed: this.wsState === WebSocket.CLOSED, hasSource })) return;
      const url = liveReportUrl("error", this.streamKind, { code, text: (e?.message ?? "").slice(0, 120) });
      void fetch(url, { credentials: "same-origin" }).catch(() => {});
    });
  }

  /**
   * go2rtc sends the codec name, then the MP4 header, then media segments. Hold
   * the first two until the first segment arrives, repair the header from that
   * segment, and only then let VideoRTC create its buffer. go2rtc starts on a
   * keyframe, so this adds no delay to the first picture.
   */
  onmse() {
    super.onmse();
    const start = this.onmessage?.["mse"];
    if (!this.onmessage || !start) return;
    let reply: { type: string; value: string } | null = null;
    let header: ArrayBuffer | null = null;
    this.onmessage["mse"] = (msg) => {
      if (msg.type === "mse") reply = msg;
    };
    this.ondata = (data) => {
      if (!reply) return; // go2rtc sends its reply before any bytes
      if (!header) {
        header = data;
        return;
      }
      let fixed: ReturnType<typeof repairInit> = null;
      try {
        fixed = repairInit(new Uint8Array(header), new Uint8Array(data));
      } catch {
        // an unexpected layout: play the stream as go2rtc sent it
      }
      const codecs = fixed ? reply.value.replace(/avc1\.[0-9A-Fa-f]{6}/, fixed.codec) : reply.value;
      start({ type: "mse", value: codecs }); // creates the buffer and replaces this.ondata
      this.ondata?.(fixed ? (fixed.init.buffer as ArrayBuffer) : header);
      this.ondata?.(data);
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Drop the stream now and everything that would keep this element alive. */
  dispose() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ondisconnect();
    this.remove();
  }

  /** Reconnect a stream whose frames stopped while its socket stayed open. */
  restart() {
    this.ondisconnect();
    this.onconnect();
  }
}

if (!customElements.get("cam-stream")) customElements.define("cam-stream", CamStream);

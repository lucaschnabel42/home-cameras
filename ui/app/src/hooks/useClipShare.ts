import { useEffect, useRef, useState } from "react";
import type { PlayRequest } from "../components/ActivityFeed";
import { clipFileName, handOver } from "../lib/saveFile";

export type ShareState = { busy: boolean; progress: number | null; error: string | null };

/**
 * Share (or download) the MP4 of a clip. The file is read with progress, kept
 * after the first read, and handed to the share sheet; a browser that cannot
 * share files downloads it (lib/saveFile.ts handOver). shareSize is the size
 * of the file from a HEAD request, null until it answers.
 */
export function useClipShare(clip: PlayRequest) {
  // The downloaded file, kept so a share the phone refused can be tapped again
  // without a second download.
  const fileRef = useRef<File | null>(null);
  const [shareState, setShareState] = useState<ShareState>({ busy: false, progress: null, error: null });
  const name = clipFileName(clip.camera, clip.start);
  const canShareFiles = typeof navigator.canShare === "function";
  const [shareSize, setShareSize] = useState<number | null>(null);

  useEffect(() => {
    if (!clip.shareUrl) return;
    let live = true;
    fetch(clip.shareUrl, { method: "HEAD", credentials: "same-origin" })
      .then((r) => {
        const n = Number(r.headers.get("Content-Length"));
        if (live && r.ok && n > 0) setShareSize(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [clip.shareUrl]);

  const handOverClip = (file: File) => handOver(file, clip.title);

  async function share() {
    if (shareState.busy || !clip.shareUrl) return;
    // A file already downloaded goes straight to the share sheet. This tap is
    // a fresh user gesture, which iOS needs if it refused the first share.
    if (fileRef.current) {
      try {
        await handOverClip(fileRef.current);
        setShareState({ busy: false, progress: null, error: null });
      } catch (e) {
        const cancelled = (e as Error).name === "AbortError";
        setShareState({ busy: false, progress: null, error: cancelled ? null : "Sharing did not open. Tap Share again." });
      }
      return;
    }
    setShareState({ busy: true, progress: 0, error: null });
    let file: File;
    try {
      const r = await fetch(clip.shareUrl, { credentials: "same-origin" });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      // Read with progress: a padded clip is often 30 MB or more.
      const total = Number(r.headers.get("Content-Length")) || 0;
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total) setShareState((s) => ({ ...s, progress: Math.round((got / total) * 100) }));
      }
      file = new File(parts as BlobPart[], name, { type: "video/mp4" });
      fileRef.current = file;
    } catch {
      setShareState({ busy: false, progress: null, error: "Could not get the clip file. Try again." });
      return;
    }
    try {
      await handOverClip(file);
      setShareState({ busy: false, progress: null, error: null });
    } catch (e) {
      // The file is here; only the share sheet said no (often an expired tap
      // after a long download). The next tap shares the kept file at once.
      const cancelled = (e as Error).name === "AbortError";
      setShareState({ busy: false, progress: null, error: cancelled ? null : "Sharing did not open. Tap Share again." });
    }
  }

  return { shareState, shareSize, share, name, canShareFiles };
}

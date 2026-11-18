// Full screen for a video on iPhone and elsewhere. iPhone Safari has no
// Element.requestFullscreen; a <video> there has webkitEnterFullscreen, which
// also gives pinch zoom.
type IOSVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function enterFullscreen(container: HTMLElement): void {
  const video = container.querySelector("video") as IOSVideo | null;
  if (video?.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
    return;
  }
  void (container.requestFullscreen?.() ?? video?.requestFullscreen?.());
}

/** True when the browser can show a whole element full screen (not iPhone Safari). */
export const canFullscreenPage = () => typeof document !== "undefined" && !!document.fullscreenEnabled;

/**
 * The whole element full screen, and landscape on a phone where the browser
 * allows a lock (Android Chrome in full screen). A refusal is not an error:
 * the page works as it is.
 */
export async function enterPageFullscreen(el: HTMLElement, landscape: boolean): Promise<void> {
  try {
    await el.requestFullscreen?.();
  } catch {
    return;
  }
  if (!landscape) return;
  try {
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
  } catch {
    // Most browsers refuse an orientation lock; the layout follows the screen.
  }
}

/** Leaves full screen, if the page is in it. */
export function leavePageFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

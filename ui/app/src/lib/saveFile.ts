// Give a file to the person: the share sheet where the browser can share
// files (an iPhone, so a still can go to Photos), a download elsewhere.

/**
 * Hands the file over. Throws AbortError when the person closes the share
 * sheet. `share` false skips the share sheet: a desktop browser that can share
 * files (Edge on Windows) would open the system share window for a download.
 */
export async function handOver(file: File, title: string, share = true): Promise<void> {
  if (share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "garage_cam-20261118-071305.jpg", in the device's local time. */
export function stillFileName(camera: string, at: Date, ext = "jpg"): string {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${camera}-${day}-${time}.${ext}`;
}

/** "garage_cam-20261118-0713.mp4", in the device's local time. */
export function clipFileName(camera: string, startS: number): string {
  const d = new Date(startS * 1000);
  return `${camera}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.mp4`;
}

/**
 * The picture that a video element shows now, as a JPEG file. Null when the
 * video has no frame yet. The live stream comes from this origin, so the
 * canvas is not tainted.
 */
export async function frameOf(video: HTMLVideoElement | null, name: string): Promise<File | null> {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")?.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  return blob ? new File([blob], name, { type: "image/jpeg" }) : null;
}

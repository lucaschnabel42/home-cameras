// Push alerts on this device: the service worker, the permission, and the
// subscription that cam-helper sends to. On iPhone this works only in the app
// opened from the Home Screen (iOS 16.4 or later), never in a Safari tab.
import { getPushKey, subscribePush, testPush, unsubscribePush } from "./helper";

export type PushState =
  | "unsupported" // no service worker or PushManager here
  | "unreachable" // on here, but the alert service could not be told
  | "needs-home-screen" // iPhone Safari tab: add the app to the Home Screen first
  | "blocked" // the person said no; only Settings can undo it
  | "off"
  | "on";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Register the service worker once at start; it does nothing until a push. */
export function registerWorker(): void {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

// Not navigator.serviceWorker.ready: it never settles when registration
// failed, and the sheet would wait forever.
async function currentSub(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** The worker, registered now if the start-up registration has not finished or failed. */
async function worker(): Promise<ServiceWorkerRegistration> {
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  if (reg.active) return reg;
  await new Promise<void>((resolve, reject) => {
    const sw = reg.installing ?? reg.waiting;
    if (!sw) return reject(new Error("no worker"));
    sw.addEventListener("statechange", () => (sw.state === "activated" ? resolve() : sw.state === "redundant" && reject(new Error("worker failed"))));
  });
  return reg;
}

/** Same bytes? (applicationServerKey of a subscription against the helper's key.) */
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/**
 * The state, after making sure the helper holds this phone's subscription:
 * it is sent again (harmless if known), and one made with an old key (the
 * helper's state was reset) is replaced without asking again.
 */
export async function pushState(): Promise<PushState> {
  if (isIos() && !standalone()) return "needs-home-screen";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  let sub = await currentSub();
  if (!sub) return "off";
  try {
    const key = keyBytes((await getPushKey()).publicKey);
    if (!sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      const reg = await worker();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await subscribePush(sub);
    return "on";
  } catch {
    return "unreachable";
  }
}

/** base64url -> bytes, for applicationServerKey. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Must run inside a tap: iOS asks for permission only from a user gesture. */
export async function turnOn(): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "off";
  const { publicKey } = await getPushKey();
  const reg = await worker();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  try {
    await subscribePush(sub);
  } catch (e) {
    await sub.unsubscribe(); // never "on" here while the helper does not know this phone
    throw e;
  }
  return "on";
}

export async function turnOff(): Promise<PushState> {
  const sub = await currentSub();
  if (sub) {
    await unsubscribePush(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}

export async function sendTest(): Promise<void> {
  const sub = await currentSub();
  if (!sub) throw new Error("not subscribed");
  // The helper may have lost it (state reset): subscribing again is harmless.
  await subscribePush(sub);
  await testPush(sub.endpoint);
}

import { Bell, Palette, SquaresFour, Tag } from "@phosphor-icons/react";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityFeed, type PlayRequest } from "./components/ActivityFeed";
import { AlertsSheet } from "./components/AlertsSheet";
import { AppearanceSheet } from "./components/AppearanceSheet";
import { CameraView } from "./components/CameraView";
import { ClipPlayer } from "./components/ClipPlayer";
import { CameraGrid } from "./components/CameraGrid";
import { GroupBoard } from "./components/GroupBoard";
import { HomeViewChips } from "./components/HomeViewChips";
import { NamesSheet } from "./components/NamesSheet";
import { NoCameras } from "./components/NoCameras";
import { PetDayCard, PetDayView, usePetDays } from "./components/PetDay";
import { SecurityMode } from "./components/security/SecurityMode";
import { AppConfigContext } from "./hooks/useAppConfig";
import { TitleContext, titleFn, useNames } from "./hooks/useNames";
import { usePoll } from "./hooks/usePoll";
import { DEFAULT_CONFIG, getAppConfig } from "./lib/appConfig";
import { activeDetections } from "./lib/detections";
import { downSentence, downSince, gapViews } from "./lib/downSince";
import { buildFeed } from "./lib/feed";
import { longDate, shortDate } from "./lib/format";
import { getCameras, getExports, getGaps, getOnline, getRecordDays, getReviews, saveLast } from "./lib/frigate";
import { getLastLive, getSummaries } from "./lib/helper";
import { readHomeView, resolveHomeView, writeHomeView, type HomeView } from "./lib/homeView";
import { applyNames, groupSections } from "./lib/names";
import { caption } from "./lib/labels";
import { focusReturn } from "./lib/focusReturn";
import { FEED_S, listEndLine } from "./lib/listEnd";
import { registerWorker } from "./lib/push";
import type { SaveMinutes } from "./lib/saveWindow";
import { lastSeen as readLastSeen, markSeen } from "./lib/seen";
import { serverNow } from "./lib/serverClock";

type View =
  | { kind: "home" }
  | { kind: "camera"; index: number }
  | { kind: "clip"; clip: PlayRequest }
  | { kind: "alerts" }
  | { kind: "theme" }
  | { kind: "names" }
  | { kind: "pet" }
  | { kind: "security" };

registerWorker();

export default function App() {
  const cameras = usePoll(getCameras, 60_000);
  const online = usePoll(getOnline, 10_000);
  const reviews = usePoll(() => getReviews(Date.now() / 1000 - FEED_S), 10_000);
  const exports = usePoll(() => getExports(), 60_000);
  const camsRef = useRef(cameras.data);
  camsRef.current = cameras.data;
  // The retention changes only with a Frigate config edit.
  const keptDays = usePoll(getRecordDays, 600_000);
  const keptRef = useRef(keptDays.data);
  keptRef.current = keptDays.data;
  // Recording gaps per camera, asked for over the whole retention: the feed
  // rows use the last FEED_S of it, and "since when" uses the gap still open
  // (lib/downSince.ts). Throws until the cameras and the retention are known,
  // so the poll retries quickly instead of caching an empty answer.
  const gaps = usePoll(async () => {
    const cams = camsRef.current?.filter((c) => !c.liveOnly);
    const days = keptRef.current;
    if (!cams || !days) throw new Error("no cameras or retention yet");
    const now = serverNow();
    const retainS = days * 86_400;
    return Promise.all(cams.map((c) => getGaps(c.name, now - retainS, now).then((g) => ({ camera: c.name, ...gapViews(c.name, g, now, FEED_S, retainS) }))));
  }, 60_000);
  // cam-helper's last-live time, for a camera down longer than the retention. Optional.
  const lastLive = usePoll(getLastLive, 60_000);
  // cam-helper is optional: if it is down, rows show their plain captions.
  const summaries = usePoll(() => getSummaries(Date.now() / 1000 - FEED_S), 60_000);
  // The install's settings: the pet and the optional features. Never fails.
  const config = usePoll(getAppConfig, 10 * 60_000).data ?? DEFAULT_CONFIG;
  const pet = config.pet;
  const petDays = usePetDays(config.features.petDay);
  // The user's names and groups, from cam-helper. Optional: without it the
  // titles are the derived names, as before. The Frigate key stays the key.
  const names = useNames();
  const titleOf = useMemo(() => titleFn(names.doc), [names.doc]);
  // What Home shows on this device: all cameras, by group, or one group.
  const [homeView, setHomeViewState] = useState<HomeView>(readHomeView);
  const setHomeView = (v: HomeView) => {
    setHomeViewState(v);
    writeHomeView(v);
  };

  const [view, setViewState] = useState<View>({ kind: "home" });
  // Overlays get a history entry, so the iOS edge swipe and Android back close them.
  const pushed = useRef(false);
  // Focus goes back to the control that opened an overlay (lib/focusReturn.ts).
  const opener = useRef(focusReturn());
  const setView = (v: View) => {
    if (v.kind !== "home") opener.current.remember(document.activeElement as HTMLElement | null);
    if (v.kind !== "home" && !pushed.current) {
      window.history.pushState({ overlay: true }, "");
      pushed.current = true;
    }
    if (v.kind === "home" && pushed.current) {
      pushed.current = false;
      window.history.back(); // popstate below sets home
      return;
    }
    setViewState(v);
  };
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      setViewState({ kind: "home" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (view.kind === "home") opener.current.restore();
  }, [view.kind]);

  // "New since you last looked": the time this phone last left the app. It is
  // read when the app opens or comes back, and written when it goes away.
  const [seen, setSeen] = useState(readLastSeen);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") markSeen(Date.now() / 1000);
      else setSeen(readLastSeen());
    };
    const onHide = () => markSeen(Date.now() / 1000);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  // Server time, so that a wrong phone clock does not make a false gap row.
  const now = new Date(serverNow() * 1000);
  const feed = useMemo(() => buildFeed(reviews.data ?? [], exports.data ?? []), [reviews.data, exports.data]);

  // A push alert opens the app at /#review=<id>: play that event once it is in the feed.
  const [linked, setLinked] = useState(() => new URLSearchParams(location.hash.slice(1)).get("review"));
  // An alert tap while the app is open names a review newer than the loaded
  // feed: poll once more before giving up.
  const linkRetried = useRef(false);
  useEffect(() => {
    const onHash = () => {
      linkRetried.current = false;
      setLinked(new URLSearchParams(location.hash.slice(1)).get("review"));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!linked || !reviews.data) return;
    const e = feed.events.find((x) => x.reviewIds.includes(linked));
    if (!e && !linkRetried.current) {
      linkRetried.current = true;
      void reviews.refresh();
      return;
    }
    history.replaceState(history.state, "", location.pathname);
    setLinked(null);
    if (e?.clipUrl) {
      const title = summaries.data?.[linked]?.title ?? caption(e.labels, titleOf(e.camera), pet);
      // Start at the event the alert named, not at the first event of its clip.
      const startAt = e.moments.find((m) => m.id === linked)?.start;
      setView({ kind: "clip", clip: { title, camera: e.camera, start: e.start, clipUrl: e.clipUrl, window: e.window, shareUrl: e.shareUrl, startAt } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, reviews.data, feed]);

  // The helper and the gap list are extras: their failure is not "can't reach the recorder".
  const unreachable = [cameras, online, reviews, exports].some((p) => p.error);
  const nothingLoaded = !cameras.data && !reviews.data;
  const cams = useMemo(() => cameras.data && applyNames(cameras.data, names.doc), [cameras.data, names.doc]);
  const sections = useMemo(() => (cams ? groupSections(cams, names.doc) : []), [cams, names.doc]);
  const groups = sections.filter((s) => s.id !== null);
  const shownView = cams ? resolveHomeView(homeView, cams, names.doc) : homeView;
  const oneGroup = shownView.kind === "group" ? sections.find((s) => s.id === shownView.id) : undefined;
  // undefined while stats are unknown (never loaded, or the last poll failed): a
  // tile then tries to play instead of showing a state that may be stale.
  const onlineMap = online.error ? undefined : online.data;
  // Tiles wait for the first stats answer (or its failure): an offline camera
  // drawn big and then shrunk moves the whole page.
  const statsKnown = !!online.data || !!online.error;
  const feedState = reviews.data ? "ready" : reviews.error ? "failed" : "loading";
  // The cameras with a detection now, for the mark on their tiles.
  const active = useMemo(() => activeDetections(reviews.data ?? [], serverNow()), [reviews.data]);
  const feedGaps = useMemo(() => gaps.data?.flatMap((g) => g.spots) ?? [], [gaps.data]);
  // One sentence for the tile, the feed row and the camera view.
  const downText = (camera: string) => {
    const days = keptDays.data ?? 0;
    const nowS = now.getTime() / 1000;
    const d = downSince({
      gap: gaps.data?.find((g) => g.camera === camera)?.ongoing ?? null,
      lastLive: lastLive.data?.[camera]?.last_live ?? null,
      retainStartS: nowS - days * 86_400,
    });
    return downSentence(d, days, now);
  };

  async function save(camera: string, minutes: SaveMinutes) {
    const r = await saveLast(camera, minutes);
    if (r.success) void exports.refresh();
    return r;
  }

  const openCamera = (name: string) => {
    const i = cams?.findIndex((c) => c.name === name) ?? -1;
    if (i >= 0) setView({ kind: "camera", index: i });
  };
  const play = (clip: PlayRequest) => setView({ kind: "clip", clip });

  return (
    <AppConfigContext.Provider value={config}>
      <TitleContext.Provider value={titleOf}>
      <MotionConfig reducedMotion="user">
        {/* While an overlay is open, the home screen is inert: VoiceOver and
            the keyboard stay in the overlay. */}
        <main className="screen home" inert={view.kind !== "home"}>
          <header className="home-head">
            <div>
              <h1 className="title">Home</h1>
              {/* The phone header has four buttons: the long date would take two lines there. */}
              <p className="subtitle">
                <span className="date-long">{longDate(now)}</span>
                <span className="date-short">{shortDate(now)}</span>
              </p>
            </div>
            <div className="home-actions">
              {cams && cams.length > 0 && (
                <button className="wall-open glass" onClick={() => setView({ kind: "security" })} aria-label="Security mode">
                  <SquaresFour size={20} aria-hidden="true" />
                  <span aria-hidden="true">Security mode</span>
                </button>
              )}
              {cams && cams.length > 0 && (
                <button className="round glass" onClick={() => setView({ kind: "names" })} aria-label="Names and groups" title="Names and groups">
                  <Tag size={20} aria-hidden="true" />
                </button>
              )}
              <button className="round glass" onClick={() => setView({ kind: "theme" })} aria-label="Theme">
                <Palette size={20} aria-hidden="true" />
              </button>
              <button className="round glass" onClick={() => setView({ kind: "alerts" })} aria-label="Alerts">
                <Bell size={20} aria-hidden="true" />
              </button>
            </div>
          </header>

          {unreachable && (
            <div className="banner glass" role="alert">
              {nothingLoaded ? "Can't reach the recorder. Trying again." : "Can't reach the recorder. Showing what loaded last."}
            </div>
          )}

          <div className="home-layout">
            <div className="home-cams">
              {!(cams && statsKnown) && (
                <div aria-hidden="true">
                  <div className="skeleton" />
                  <div className="skeleton" />
                </div>
              )}
              {cams && statsKnown && cams.length === 0 && <NoCameras />}
              {cams && statsKnown && cams.length > 0 && groups.length > 0 && <HomeViewChips view={shownView} groups={groups} onView={setHomeView} />}
              {cams && statsKnown && cams.length > 0 &&
                (shownView.kind === "groups" ? (
                  <GroupBoard
                    sections={sections}
                    online={onlineMap}
                    active={active}
                    paused={view.kind !== "home"}
                    downText={downText}
                    onOpen={openCamera}
                    onGroup={(id) => setHomeView({ kind: "group", id })}
                  />
                ) : (
                  <CameraGrid
                    key={oneGroup?.id ?? "all"}
                    cameras={oneGroup?.cameras ?? cams}
                    online={onlineMap}
                    active={active}
                    paused={view.kind !== "home"}
                    downText={downText}
                    onOpen={openCamera}
                  />
                ))}
              {cams && statsKnown && pet && <PetDayCard pet={pet} days={petDays} onOpen={() => setView({ kind: "pet" })} />}
            </div>

            {cams && statsKnown && cams.length > 0 && (
              <div className="home-activity">
                <ActivityFeed
                  state={feedState}
                  events={feed.events}
                  saved={feed.saved}
                  gaps={feedGaps}
                  summaries={summaries.data ?? {}}
                  lastSeen={seen}
                  endNote={listEndLine(FEED_S, keptDays.data ?? null)}
                  downText={downText}
                  now={now}
                  onPlay={play}
                  onOpenCamera={openCamera}
                />
              </div>
            )}
          </div>
        </main>

        <AnimatePresence>
          {view.kind === "camera" && cams && (
            <CameraView
              key="camera"
              cameras={cams}
              index={view.index}
              online={onlineMap}
              downText={downText}
              onIndex={(index) => setView({ kind: "camera", index })}
              onClose={() => setView({ kind: "home" })}
              onSave={save}
              onPlay={play}
            />
          )}
          {view.kind === "clip" && (
            <ClipPlayer key="clip" clip={view.clip} summaries={summaries.data ?? {}} onClose={() => setView({ kind: "home" })} />
          )}
          {view.kind === "alerts" && <AlertsSheet key="alerts" onClose={() => setView({ kind: "home" })} />}
          {view.kind === "theme" && <AppearanceSheet key="theme" onClose={() => setView({ kind: "home" })} />}
          {view.kind === "names" && cams && <NamesSheet key="names" cameras={cams} names={names} onClose={() => setView({ kind: "home" })} />}
          {view.kind === "security" && cams && (
            <SecurityMode
              key="security"
              cameras={cams}
              names={names.doc}
              online={onlineMap}
              reviews={reviews.data ?? []}
              events={feed.events}
              summaries={summaries.data ?? {}}
              downText={downText}
              onSave={save}
              onClose={() => setView({ kind: "home" })}
            />
          )}
          {view.kind === "pet" && pet && <PetDayView key="pet" pet={pet} days={petDays} onClose={() => setView({ kind: "home" })} onPlay={play} />}
        </AnimatePresence>
      </MotionConfig>
      </TitleContext.Provider>
    </AppConfigContext.Provider>
  );
}

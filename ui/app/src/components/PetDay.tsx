import { CaretLeft, CaretRight, Pause, Play, SpeakerHigh } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useDialog } from "../hooks/useDialog";
import { usePoll } from "../hooks/usePoll";
import { dayTitle } from "../lib/activity";
import type { Pet } from "../lib/appConfig";
import { countsLine, firstSentence, mainLine, nearestMoment, petDayTitle, stripRange } from "../lib/petDay";
import { clockTime, timeRange } from "../lib/format";
import { getPetDay, getPetDays, petFileUrl, type PetDay, type PetDayInfo, type PetMoment } from "../lib/helper";
import type { PlayRequest } from "./ActivityFeed";

/** A clip of a moment starts this long before it and ends this long after it. */
const BEFORE_S = 20;
const AFTER_S = 100;
/** "Play the day" shows every moment in about this long. */
const PLAY_MS = 8000;
/** rest.jpg is the frame with the clock band cut off: about 1280 x 670. The
 * real size replaces this once it loads, so the place dots land right. */
const REST_ASPECT = 1280 / 670;

const dateOf = (d: string) => new Date(`${d}T12:00:00`).getTime() / 1000;

/**
 * The days cam-helper has, newest first. Empty until it has made one, and
 * always empty when the pet day is off: then the app asks for nothing.
 */
export function usePetDays(on: boolean): PetDayInfo[] {
  const poll = usePoll(() => (on ? getPetDays() : Promise.resolve([])), 10 * 60_000);
  useEffect(() => void poll.refresh(), [on]); // eslint-disable-line react-hooks/exhaustive-deps
  return on ? (poll.data ?? []) : [];
}

/** One day's data, polled while shown; null while it loads or if it failed. */
function usePetDay(date: string | undefined): PetDay | null {
  const [day, setDay] = useState<PetDay | null>(null);
  const poll = usePoll(() => (date ? getPetDay(date) : Promise.reject(new Error("no day"))), 10 * 60_000);
  useEffect(() => setDay(poll.data && poll.data.date === date ? poll.data : null), [poll.data, date]);
  useEffect(() => void poll.refresh(), [date]); // eslint-disable-line react-hooks/exhaustive-deps
  return day;
}

const clipFor = (camera: string, m: PetMoment, title: string): PlayRequest => ({
  title,
  camera,
  start: m.t - BEFORE_S,
  clipUrl: `/vod/${camera}/start/${Math.floor(m.t - BEFORE_S)}/end/${Math.ceil(m.t + AFTER_S)}/index.m3u8`,
  window: { start: Math.floor(m.t - BEFORE_S), end: Math.ceil(m.t + AFTER_S) },
  shareUrl: null,
});

/** Home card: the story's title and first sentence over the room picture. */
export function PetDayCard({ pet, days, onOpen }: { pet: Pet; days: PetDayInfo[]; onOpen: () => void }) {
  const day = usePetDay(days[0]?.date);
  const [broken, setBroken] = useState(false);
  if (!day || !day.rest || broken) return null;
  const line = day.story ? firstSentence(day.story.chapters[0]?.text ?? "") : mainLine(day);
  return (
    <button className="pet-card" onClick={onOpen} aria-label={`Open ${petDayTitle(pet)}`}>
      <img src={petFileUrl(day.rest)} alt="" onError={() => setBroken(true)} />
      <span className="pet-card-cap glass">
        <b>{day.story?.title ?? petDayTitle(pet)}</b>
        {line && <span>{line}</span>}
        <small>{dayTitle(dateOf(day.date), new Date())}</small>
      </span>
    </button>
  );
}

/**
 * The pet day: the story of the day first, each part with photos that play
 * the moment; then the room with one copy of the pet and a strip across the
 * day. Drag the strip to see where the pet was at any time.
 */
export function PetDayView({
  pet,
  days,
  onClose,
  onPlay,
}: {
  pet: Pet;
  days: PetDayInfo[];
  onClose: () => void;
  onPlay: (p: PlayRequest) => void;
}) {
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  const [i, setI] = useState(0);
  const info = days[Math.min(i, days.length - 1)];
  const day = usePetDay(info?.date);
  const [shown, setShown] = useState<PetMoment | null>(null);
  const [playing, setPlaying] = useState(false);
  const [aspect, setAspect] = useState(REST_ASPECT);
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const reduce = useReducedMotion();
  const now = new Date();

  useEffect(() => {
    setShown(null);
    setPlaying(false);
  }, [info?.date]);

  // "Play the day": step through every moment, then stop on the last.
  useEffect(() => {
    if (!playing || !day || day.moments.length < 2) return;
    let k = 0;
    const step = Math.max(120, PLAY_MS / day.moments.length);
    const t = window.setInterval(() => {
      setShown(day.moments[k]);
      if (++k >= day.moments.length) {
        window.clearInterval(t);
        setPlaying(false);
      }
    }, step);
    return () => window.clearInterval(t);
  }, [playing, day]);

  if (!info) return null;
  const range = day ? stripRange(day) : null;
  const pct = (t: number) => (range ? ((t - range[0]) / Math.max(1, range[1] - range[0])) * 100 : 0);
  const momentByT = new Map(day?.moments.map((m) => [m.t, m]) ?? []);
  const placeName = (id: number) => day?.places.find((p) => p.id === id)?.name ?? null;
  const titleOf = (m: PetMoment) => m.title ?? `${pet.name} at ${clockTime(m.t)}`;

  const scrub = (e: PointerEvent) => {
    const r = strip.current?.getBoundingClientRect();
    if (!r || !range || !day) return;
    const t = range[0] + ((e.clientX - r.left) / r.width) * (range[1] - range[0]);
    setPlaying(false);
    setShown(nearestMoment(day.moments, t));
  };

  return (
    <motion.div className="overlay panel pet" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>{petDayTitle(pet)}</span>
      </div>
      <div className="pet-body">
        <div className="pet-nav">
          <button className="round glass" disabled={i >= days.length - 1} onClick={() => setI(i + 1)} aria-label="Day before">
            <CaretLeft size={20} aria-hidden="true" />
          </button>
          <span>{dayTitle(dateOf(info.date), now)}</span>
          <button className="round glass" disabled={i === 0} onClick={() => setI(i - 1)} aria-label="Day after">
            <CaretRight size={20} aria-hidden="true" />
          </button>
        </div>

        {!day && <div className="skeleton feed-skeleton" aria-hidden="true" />}

        {day && day.story && (
          <article className="pet-story">
            <h2>{day.story.title}</h2>
            <p className="pet-written">
              {day.story.final ? "The whole day" : `So far, written at ${clockTime(day.story.written)}`}
            </p>
            {day.story.chapters.map((c) => {
              const ms = c.moments.map((t) => momentByT.get(t)).filter((m): m is PetMoment => !!m);
              return (
                <section key={c.start} className={c.code ? "chapter code" : "chapter"}>
                  <p className="chapter-time tnum">
                    {c.code && <SpeakerHigh size={14} aria-hidden="true" />} {timeRange(c.start, c.end)}
                  </p>
                  <p className="chapter-text">{c.text}</p>
                  {ms.length > 0 && (
                    <div className="chapter-frames">
                      {ms.slice(0, 3).map((m) => (
                        <button key={m.t} className="chapter-frame" onClick={() => onPlay(clipFor(pet.camera, m, titleOf(m)))} aria-label={`Watch ${titleOf(m)}`}>
                          <img src={petFileUrl(m.image)} alt="" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </article>
        )}
        {day && !day.story && (
          <p className="pet-pending">The story is written when the computer is free. Here is where {pet.name} went so far.</p>
        )}

        {day && day.rest && (
          <section className="pet-where" aria-label={`Where ${pet.name} went`}>
            <h2 className="section">Where {pet.name} went</h2>
            {/* A moment image is a 16:9 crop; the room picture is wider (its
                clock band is cut off). Each gets its own shape, so nothing of
                the pet is cropped away and the place dots land right. */}
            <div className="pet-pic" style={{ aspectRatio: shown ? 16 / 9 : aspect }}>
              {shown ? (
                <img key={shown.t} src={petFileUrl(shown.image)} alt={titleOf(shown)} />
              ) : (
                <>
                  <img
                    src={petFileUrl(day.rest)}
                    alt={`The room, with ${pet.name} at the main spot`}
                    onLoad={(e) => e.currentTarget.naturalHeight && setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
                  />
                  {day.places.map((p) => (
                    <i
                      key={p.id}
                      className={p.id === day.main?.place ? "place-dot main" : "place-dot"}
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                      aria-hidden="true"
                    />
                  ))}
                </>
              )}
              {shown && (
                <span className="pet-clock glass tnum">
                  {clockTime(shown.t)}
                  {placeName(shown.place) ? `, ${placeName(shown.place)}` : ""}
                </span>
              )}
            </div>
            {shown ? (
              <div className="pet-shown">
                <b>{titleOf(shown)}</b>
                <button className="chip" onClick={() => onPlay(clipFor(pet.camera, shown, titleOf(shown)))}>
                  Watch this moment
                </button>
              </div>
            ) : (
              <div className="pet-shown">
                {mainLine(day) && <b>{mainLine(day)}</b>}
                <span>{countsLine(day)}</span>
              </div>
            )}

            {range && (
              <>
                <div
                  ref={strip}
                  className="pet-strip"
                  role="slider"
                  aria-label={`Drag to see where ${pet.name} was`}
                  aria-valuemin={range[0]}
                  aria-valuemax={range[1]}
                  aria-valuenow={shown?.t ?? range[0]}
                  aria-valuetext={shown ? clockTime(shown.t) : "Start of the day"}
                  onPointerDown={(e) => {
                    dragging.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    scrub(e);
                  }}
                  onPointerMove={(e) => dragging.current && scrub(e)}
                  onPointerUp={() => (dragging.current = false)}
                  onPointerCancel={() => (dragging.current = false)}
                >
                  {day.ribbon.map((r) => (
                    <i
                      key={`${r.start}`}
                      className={r.place === day.main?.place ? "seg main" : "seg"}
                      style={{ left: `${pct(r.start)}%`, width: `max(2px, ${pct(r.end) - pct(r.start)}%)` }}
                    />
                  ))}
                  {day.barks.map((b) => (
                    <i key={`b${b.start}`} className="bark" style={{ left: `${pct(b.start)}%` }} />
                  ))}
                  {shown && <i className="head" style={{ left: `${pct(shown.t)}%` }} />}
                </div>
                <div className="pet-strip-times tnum">
                  <span>{clockTime(range[0])}</span>
                  <span>{clockTime(range[1])}</span>
                </div>
                <div className="pet-actions">
                  {!reduce && day.moments.length > 1 && (
                    <button className="chip" onClick={() => setPlaying(!playing)}>
                      {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      {playing ? " Stop" : " Play the day"}
                    </button>
                  )}
                  {shown && (
                    <button className="chip" onClick={() => setShown(null)}>
                      Back to the room
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </motion.div>
  );
}

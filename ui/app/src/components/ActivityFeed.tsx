import { CaretDown, VideoCameraSlash } from "@phosphor-icons/react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clockUnder, gapRowStart, groupSessions, sections, span, type BlindSpot, type Row, type Session } from "../lib/activity";
import type { ClipWindow, EventEntry, SavedEntry } from "../lib/feed";
import { clockTime, shortDay, timeRange } from "../lib/format";
import { useTitleOf } from "../hooks/useNames";
import type { Summary } from "../lib/helper";
import { usePet } from "../hooks/useAppConfig";
import { caption, kindName, kinds, KINDS, lowerTitle, subject, type Kind } from "../lib/labels";
import { eventCount, filterEntries, rowLength, visitRows, type VisitRow } from "../lib/visits";
import { OrbField } from "./OrbField";

export interface PlayRequest {
  title: string;
  camera: string;
  start: number;
  clipUrl: string;
  /** Span the file covers; null for a clip with no readable tag (no timeline). */
  window: ClipWindow | null;
  /** A complete MP4 for sharing; null when none exists yet. */
  shareUrl: string | null;
  /**
   * Wall time of the event the person chose. The player starts 2 s before it
   * (lib/timeline.ts playStart). Without it, the player starts at the first
   * detection in the clip.
   */
  startAt?: number;
}

type Filter = "all" | Kind;

function Thumb({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="thumb">
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : <OrbField />}
    </div>
  );
}

/**
 * One event row. The row is a button that plays the clip, so "Show more" for a
 * summary cut at two lines is a separate button below it, and opening the
 * text does not start the clip. The link shows only when the text is cut.
 */
function EventRow({
  sub,
  thumb,
  head,
  summary,
  onPlay,
}: {
  sub: boolean;
  thumb: string;
  /** The title and the time line. */
  head: ReactNode;
  summary: string | null;
  onPlay: () => void;
}) {
  const text = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary, open]);
  return (
    <div className={sub ? "event sub" : "event"}>
      <button className={sub ? "clip sub" : "clip"} onClick={onPlay}>
        <Thumb src={thumb} />
        <div>
          {head}
          {summary && (
            <small ref={text} className={open ? "summary open" : "summary"}>
              {summary}
            </small>
          )}
        </div>
      </button>
      {summary && (cut || open) && (
        <button className="more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * "Living room, 11:31 pm · 40 s", or the state while the clip is not cut yet.
 * A row with joined events ends "and 1 more moment". headerS is a time on the
 * day of the header the row sits under.
 */
function eventLine(r: VisitRow, now: Date, headerS: number, cameraTitle: (camera: string) => string): { text: string; accent: boolean } {
  const nowS = now.getTime() / 1000;
  const where = `${cameraTitle(r.entry.camera)}, ${clockUnder(r.start, headerS, now)}`;
  const more = r.more ? ` · and ${r.more} more moment${r.more === 1 ? "" : "s"}` : "";
  if (r.entry.state === "recording" || (r.entry.state !== "ready" && r.end === null)) {
    return { text: `${where} · happening now${more}`, accent: true };
  }
  if (r.entry.state !== "ready") return { text: `${where} · saving to your drive${more}`, accent: true };
  return { text: `${where} · ${rowLength(r, nowS)}${more}`, accent: false };
}

/** Activity: filter chips, then days, each with visits and recording gaps; then saved clips. */
export function ActivityFeed({
  state,
  events,
  saved,
  gaps,
  summaries,
  lastSeen,
  endNote,
  downText,
  now,
  onPlay,
  onOpenCamera,
}: {
  /** "loading" until the first review list arrives, "failed" if none ever did. */
  state: "loading" | "failed" | "ready";
  events: EventEntry[];
  saved: SavedEntry[];
  gaps: BlindSpot[];
  summaries: Record<string, Summary>;
  /** When this device last left the app; newer rows get a dot. null on a first visit. */
  lastSeen: number | null;
  /** The line after the last day: how far back the list and the recordings go. */
  endNote: string;
  /** The sentence for a camera that does not record (lib/downSince.ts). */
  downText: (camera: string) => string;
  now: Date;
  onPlay: (p: PlayRequest) => void;
  onOpenCamera: (camera: string) => void;
}) {
  const pet = usePet();
  const cameraTitle = useTitleOf();
  const [chosen, setFilter] = useState<Filter>("all");
  // A chip shows only for a kind that the list holds: a home with no vehicle
  // camera gets no Vehicles chip. A chosen kind that left the list falls back to All.
  const present = useMemo(() => {
    const found = new Set<Kind>();
    for (const e of events) for (const m of e.moments) for (const k of kinds(m.labels)) found.add(k);
    return KINDS.filter((k) => found.has(k));
  }, [events]);
  const filter: Filter = chosen === "all" || present.includes(chosen) ? chosen : "all";
  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    ...present.map((k) => ({ key: k, label: kindName(k, pet) })),
  ];
  const [open, setOpen] = useState<Set<string>>(new Set());
  const nowS = now.getTime() / 1000;

  const days = useMemo(() => {
    // The filter works per event: a clip keeps only its events of that kind.
    const shown = filterEntries(events, filter);
    const rows: Row[] = groupSessions(shown).map((s) => ({ kind: "session", start: s.start, session: s }));
    if (filter === "all") for (const g of gaps) rows.push({ kind: "gap", start: gapRowStart(g, nowS), gap: g });
    return sections(rows, now);
    // `now` changes every render; the day titles only need the date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, gaps, filter, now.toDateString()]);

  const isNew = (t: number) => lastSeen !== null && t > lastSeen;
  // Count what carries a dot: a row, or a visit with anything new in it.
  const newCount =
    lastSeen === null
      ? 0
      : days.reduce(
          (n, d) => n + d.rows.filter((r) => r.kind === "session" && r.session.entries.some((e) => e.moments.some((m) => isNew(m.start)))).length,
          0,
        );

  // A tap plays the clip that covers the event, from 2 s before the event.
  const play = (r: VisitRow) => {
    const e: EventEntry = r.entry;
    const title = r.summary?.title ?? caption(r.labels, cameraTitle(e.camera), pet);
    if (e.clipUrl) onPlay({ title, camera: e.camera, start: e.start, clipUrl: e.clipUrl, window: e.window, shareUrl: e.shareUrl, startAt: r.start });
    else onOpenCamera(e.camera);
  };

  const eventRow = (r: VisitRow, sub = false, headerS = r.start) => {
    const line = eventLine(r, now, headerS, cameraTitle);
    return (
      <EventRow
        key={r.key}
        sub={sub}
        thumb={r.thumbUrl}
        summary={r.summary?.summary ?? null}
        onPlay={() => play(r)}
        head={
          <>
            <b>
              {isNew(r.start) && <i className="new-dot" aria-label="New" />}
              {r.summary?.title ?? subject(r.labels, pet)}
            </b>
            <span className={line.accent ? "state tnum" : "tnum"}>{line.text}</span>
          </>
        }
      />
    );
  };

  // A visit with one row is that row. A visit with more rows (several clips,
  // or one clip that holds several events) folds open to one row per event.
  const sessionRow = (s: Session) => {
    const rows = visitRows(s.entries, summaries);
    if (rows.length === 1) return eventRow(rows[0]);
    const expanded = open.has(s.key);
    const newest = rows[0];
    const toggle = () =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(s.key)) next.delete(s.key);
        else next.add(s.key);
        return next;
      });
    return (
      <div key={s.key} className={expanded ? "visit open" : "visit"}>
        <button className="clip" onClick={toggle} aria-expanded={expanded}>
          <Thumb src={newest.thumbUrl} />
          <div>
            <b>
              {rows.some((r) => isNew(r.start)) && <i className="new-dot" aria-label="New" />}
              {subject(s.labels, pet)}, {eventCount(s.entries)} times
            </b>
            <span className="tnum">
              {cameraTitle(s.camera)}, {timeRange(s.start, s.end)}
            </span>
          </div>
          <CaretDown className="caret" size={18} aria-hidden="true" />
        </button>
        {expanded && <div className="visit-rows">{rows.map((r) => eventRow(r, true, s.start))}</div>}
      </div>
    );
  };

  const gapRow = (g: BlindSpot) => (
    <button key={`g:${g.camera}:${g.start}`} className="clip gap" onClick={() => onOpenCamera(g.camera)}>
      <div className="thumb gap-icon">
        <VideoCameraSlash size={26} aria-hidden="true" />
      </div>
      <div>
        {/* A gap still open gives the same sentence as the tile and the camera view. */}
        <b>{g.ongoing ? cameraTitle(g.camera) : `${cameraTitle(g.camera)} not recording`}</b>
        <span className="tnum">
          {g.ongoing
            ? downText(g.camera)
            : g.openStart
                ? `Until ${clockTime(g.end)}`
                : `${clockTime(g.start)} to ${clockTime(g.end)} · ${span(g.end - g.start)}`}
        </span>
      </div>
    </button>
  );

  return (
    <section aria-label="Activity">
      <h2 className="section">Activity</h2>
      {newCount > 0 && lastSeen !== null && (
        <p className="new-line">
          <i className="new-dot" aria-hidden="true" />
          {newCount} new since {shortDay(lastSeen, now).replace(/^at /, "")}
          {clockTime(lastSeen)}
        </p>
      )}
      {filters.length > 1 && (
        <div className="chips" role="group" aria-label="Show">
          {filters.map((f) => (
            <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {state === "loading" && <div className="skeleton feed-skeleton" aria-hidden="true" />}
      {state !== "loading" && days.length === 0 && (
        <div className="empty">
          <OrbField>
            <span className="orb-label">
              {state === "failed"
                ? "Activity could not load yet"
                : filter === "all"
                  ? "Nothing in the last two days"
                  : "Nothing like that in the last two days"}
            </span>
          </OrbField>
        </div>
      )}
      {days.map((d) => (
        <div key={d.title}>
          <p className="when">{d.title}</p>
          {d.rows.map((r) => (r.kind === "gap" ? gapRow(r.gap) : sessionRow(r.session)))}
        </div>
      ))}
      {days.length > 0 && <p className="list-end">{endNote}</p>}

      {saved.length > 0 && (
        <>
          <h2 className="section">Saved</h2>
          {saved.map((s) => {
            const title = `${s.title}, ${lowerTitle(cameraTitle(s.camera))}`;
            const when = s.end ?? s.date;
            const ready = s.state === "ready" && !!s.clipUrl;
            return (
              <button
                key={s.key}
                className="clip"
                disabled={!ready}
                onClick={() =>
                  s.clipUrl &&
                  onPlay({ title, camera: s.camera, start: s.start ?? s.date, clipUrl: s.clipUrl, window: s.window, shareUrl: s.shareUrl })
                }
              >
                <Thumb src={s.state === "ready" ? s.thumbUrl : ""} />
                <div>
                  <b>{title}</b>
                  <span className={s.state === "exporting" ? "state tnum" : "tnum"}>
                    {s.state === "exporting" ? "Preparing clip" : `Saved ${shortDay(when, now)}${clockTime(when)}`}
                  </span>
                </div>
              </button>
            );
          })}
        </>
      )}
    </section>
  );
}

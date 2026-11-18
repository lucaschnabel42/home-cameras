"""Export one MP4 per Frigate event, padded 2.5 min before and after.

Frigate caps pre_capture at 60 s (MAX_PRE_CAPTURE in frigate/const.py), so the
padding cannot come from the record config. This service polls Frigate's review
items and asks Frigate to export [start - PAD, end + PAD] from the continuous
recordings. Frigate writes each export to /media/frigate/exports (MEDIA_DIR/exports
on the host) and lists it on its Exports page.

How a clip is tracked:
- What is already covered comes from Frigate, not from this service's memory:
  an event is covered when a tagged event export of its camera contains its
  start, the same rule the app uses (ui/app/src/lib/feed.ts). A lost state
  file therefore makes no duplicates.
- An export request is asynchronous (202 "queued"); Frigate creates the row
  only when a worker starts the job, and can still fail it. A request stays
  "pending" until the file checks out: the row exists, is done, and the MP4
  has a moov atom with a duration. A queued job is asked about through
  /api/jobs/export/{id}. A file this service cannot open is left alone, never
  deleted; only a file it read and found broken is deleted and cut again.
- A failure Frigate will repeat (HTTP 4xx, e.g. "No recordings found") is given
  up at once. Any other failure is retried with backoff, and the camera waits,
  so no later window jumps an earlier one; after MAX_ATTEMPTS (about half an
  hour) the window is given up so later clips are not held. Every give-up is
  logged as an error and kept in the state file.
- Each clip gets its full PAD before and after, even where that overlaps the
  clip before it, so every clip holds its own 2.5 min of lead-in (a trimmed
  clip held as little as 60 s). Events whose padded windows
  touch are one clip, up to MAX_WINDOW_S long.
- Coverage also counts Frigate's queued and running jobs (/api/jobs/export),
  so a request whose reply was lost is not sent twice.
- A request still pending after PENDING_MAX_S counts as a failure.
- A broken export whose delete failed is deleted again on later polls.
- With CLIP_KEEP_DAYS, an event clip whose event ended more than that many
  days ago is deleted through Frigate's API. Only clips with this service's
  event tag go; a clip that a person saved stays. A limit shorter than the
  review view plus 12 h is refused, because the event would be cut again.
- A verified clip is renamed with d=<seconds> (its real length). A backfill
  adds d= to finished clips that lack it (old clips, and renames Frigate
  overwrote) and deletes unverified clips whose file is broken.

What this does not do:
- It triggers on Frigate review items, which need a tracked object (person
  dog or cat, see objects.track in frigate/config/config.yml). Raw pixel motion
  with no object makes no clip.
- An event longer than MAX_EVENT_S is cut at that length: Frigate closes open
  events at its next start, so a power cut can make one many hours long.
- A chain of events longer than MAX_WINDOW_S becomes more than one clip.
  Above 7200 s Frigate cuts on whole segments, so the clip would no longer
  start at its tagged start and the app's timeline would shift.
- It waits SETTLE_SECONDS after the padded end so Frigate has flushed the
  recording segments. A clip appears about PAD + SETTLE seconds after an event.
"""

import json
import logging
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

FRIGATE = os.environ.get("FRIGATE_URL", "http://frigate:5000").rstrip("/")
PAD = int(os.environ.get("PAD_SECONDS", "150"))
SETTLE = int(os.environ.get("SETTLE_SECONDS", "60"))
POLL = int(os.environ.get("POLL_SECONDS", "30"))
LOOKBACK = float(os.environ.get("LOOKBACK_HOURS", "48")) * 3600
STATE_FILE = os.environ.get("STATE_FILE", "/state/exported.json")
# The days that Frigate keeps continuous recordings (record.continuous.days);
# docker-compose.yml sets it from RECORD_DAYS.
RECORD_KEEP_S = float(os.environ.get("RECORD_KEEP_DAYS", "3")) * 86400
# Event clips older than this are deleted (CLIP_KEEP_DAYS); empty or 0: never.
CLIP_KEEP_S = float(os.environ.get("CLIP_KEEP_DAYS") or 0) * 86400
# The most clips deleted in one poll, so a first run with a low limit does
# not send one huge delete.
DELETE_BATCH = 20
MAX_EVENT_S = 3600
# Below Frigate's MAX_PLAYLIST_SECONDS (7200, frigate/record/export.py).
MAX_WINDOW_S = 7000
# A request with no finished file after this long is treated as failed.
PENDING_MAX_S = 3 * 3600
MAX_BACKOFF_S = 1800
MAX_ATTEMPTS = 6
# Give up on a window this long before it leaves the LOOKBACK view.
ABANDON_MARGIN_S = 3600
LIVE_JOB = {"pending", "queued", "running", "success"}

log = logging.getLogger("clip-exporter")


def format_name(camera, start, end, labels, duration=None):
    """Export name tag the UI parses (ui/app/src/lib/clipName.ts).

    Frigate's Export.name column is max_length=100, so keys are one letter.
    d= is the real file length, added after the file is checked.
    """
    name = (f"wc1;k=e;c={camera};s={start:.0f};e={end:.0f};"
            f"l={','.join(sorted(labels))}")
    return name if duration is None else f"{name};d={duration:.0f}"


def parse_tag(name):
    """{c, s, e, d} of an event tag, or None. d is None until verified."""
    parts = (name or "").split(";")
    if parts[0] != "wc1":
        return None
    f = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
    if f.get("k") != "e" or not f.get("c"):
        return None
    try:
        return {"c": f["c"], "s": int(f["s"]), "e": int(f["e"]),
                "d": int(f["d"]) if f.get("d") else None}
    except (KeyError, ValueError):
        return None


def _labels_of(name):
    part = name.split(";l=", 1)[1].split(";", 1)[0] if ";l=" in name else ""
    return [x for x in part.split(",") if x]


def plan_windows(items, skip_ids, prior, now, pad=PAD, settle=SETTLE):
    """Return the clips that are ready to export.

    items: Frigate review segments (dicts with id, camera, start_time,
    end_time; end_time is None while the event is in progress).
    skip_ids: ids done, covered, or in flight.
    prior is accepted for the caller's coverage check and no longer trims a
    window: each clip keeps its full lead-in.
    Each result is {camera, start, end, ids, labels}.
    """
    by_cam = {}
    for it in items:
        if it["id"] in skip_ids:
            continue
        by_cam.setdefault(it["camera"], []).append(it)

    ready = []
    for cam, cam_items in by_cam.items():
        cam_items.sort(key=lambda i: i["start_time"])
        windows = []
        for it in cam_items:
            start = it["start_time"] - pad
            if it.get("end_time") is None:
                end = float("inf")
            else:
                end = min(it["end_time"], it["start_time"] + MAX_EVENT_S) + pad
            data = it.get("data") or {}
            # Sounds (bark, smoke_detector, ...) are labels too: a bark with
            # nobody in view is still a clip, named for what was heard.
            labels = set(data.get("objects") or []) | set(data.get("audio") or [])
            last = windows[-1] if windows else None
            # Merge into the window before when they touch, unless the merged
            # clip would pass MAX_WINDOW_S. An open event always merges: its
            # length is not known yet, and the next poll plans again.
            if last and start <= last["end"] and (
                    end == float("inf") or last["end"] == float("inf")
                    or max(last["end"], end) - last["start"] <= MAX_WINDOW_S):
                w = last
                w["end"] = max(w["end"], end)
                w["ids"].append(it["id"])
                w["labels"] |= labels
            else:
                windows.append({"camera": cam, "start": start, "end": end,
                                "ids": [it["id"]], "labels": labels})
        for w in windows:
            if w["end"] + settle > now:
                break  # in progress or not flushed; later windows wait too
            ready.append(w)
    return ready


def backoff_s(attempts):
    """Seconds to wait before attempt number attempts + 1."""
    return min(MAX_BACKOFF_S, 30 * 2 ** max(0, attempts - 1))


def prune_done(done, now, keep_s):
    """Drop review ids (they start with the event's unix time) older than keep_s."""
    kept = set()
    for rid in done:
        try:
            if float(rid.split("-", 1)[0]) < now - keep_s:
                continue
        except ValueError:
            pass
        kept.add(rid)
    return kept


def mp4_info(path):
    """("ok", seconds), ("bad", None), or ("unreadable", None).

    "bad" means the file was read and has no moov atom with a duration, which
    is what a killed ffmpeg leaves (the moov atom comes last). "unreadable"
    means the file could not be opened or read at all (a missing mount, a
    file still being written); such a file must not be deleted.
    Reads only box headers, so it does not load the video.
    """
    try:
        with open(path, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            pos = 0
            while pos + 8 <= size:
                f.seek(pos)
                box_size, kind = struct.unpack(">I4s", f.read(8))
                header = 8
                if box_size == 1:
                    box_size = struct.unpack(">Q", f.read(8))[0]
                    header = 16
                elif box_size == 0:
                    box_size = size - pos
                if box_size < header or pos + box_size > size:
                    return "bad", None
                if kind == b"moov":
                    secs = _mvhd_duration(f, pos + header, pos + box_size)
                    return ("ok", secs) if secs else ("bad", None)
                pos += box_size
    except OSError:
        return "unreadable", None
    except (struct.error, IndexError, ValueError):
        return "bad", None  # a header cut short: read, and broken
    return "bad", None


def _mvhd_duration(f, start, end):
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        box_size, kind = struct.unpack(">I4s", f.read(8))
        if box_size < 8:
            break
        if kind == b"mvhd":
            version = f.read(4)[0]
            if version == 1:
                _, _, timescale, duration = struct.unpack(">QQIQ", f.read(28))
            else:
                _, _, timescale, duration = struct.unpack(">IIII", f.read(16))
            if timescale and duration:
                return round(duration / timescale, 3)
            break
        pos += box_size
    return None


def new_state():
    return {"done": set(), "pending": {}, "retry": {}, "abandoned": [], "rejected": []}


def load_state():
    st = new_state()
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
        st["done"] = set(s.get("done", []))
        for k in ("pending", "retry"):
            st[k] = dict(s.get(k, {}))
        for k in ("abandoned", "rejected"):
            st[k] = list(s.get(k, []))
    except FileNotFoundError:
        log.info("no state file: what is covered comes from Frigate's exports")
    except (ValueError, TypeError, AttributeError) as e:
        # A power cut can leave the file empty or cut short. Coverage comes
        # from Frigate, so starting empty makes no duplicates.
        log.error("state file unreadable (%s); starting from Frigate's exports", e)
        st = new_state()
    return st


def save_state(st, last=None):
    """Write the state if it changed; return what was written (or last)."""
    text = json.dumps({**st, "done": sorted(st["done"])})
    if text == last:
        return last
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE_FILE)
    return text


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(FRIGATE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def _try(call, method, path, body=None):
    """A change to Frigate that must not stop the poll. True on success."""
    try:
        call(method, path, body)
        return True
    except Exception as e:  # noqa: BLE001 - logged, and the caller decides
        log.warning("%s %s failed: %s", method, path, e)
        return False


def safe_keep_s(keep_s):
    """keep_s when it is safe, else 0 (no deletion). A clip must outlive the
    review view (LOOKBACK) by a margin: a clip deleted while its event is
    still in view is not "covered", and the event would be cut again."""
    if keep_s and keep_s >= LOOKBACK + 12 * 3600:
        return keep_s
    return 0


def expired(exports, keep_s, now, skip_ids):
    """The ids of the event clips whose tagged end is more than keep_s ago.
    Only finished clips with this service's event tag go; a clip that a
    person saved has no such tag and stays."""
    if not keep_s:
        return []
    out = []
    for e in exports:
        tag = parse_tag(e.get("name"))
        old = tag is not None and tag["e"] < now - keep_s
        if old and not e.get("in_progress") and e["id"] not in skip_ids:
            out.append(e["id"])
    return out


def _expire(st, call, exports, now):
    """Delete the event clips older than CLIP_KEEP_S, at most DELETE_BATCH."""
    keep_s = safe_keep_s(CLIP_KEEP_S)
    if CLIP_KEEP_S and not keep_s:
        log.error("CLIP_KEEP_DAYS is too short: a clip must stay at least %.1f days; "
                  "no clip is deleted", (LOOKBACK + 12 * 3600) / 86400)
        return set()
    ids = expired(exports, keep_s, now, set(st["pending"]) | set(st["rejected"]))[:DELETE_BATCH]
    if ids and _try(call, "POST", "/api/exports/delete", {"ids": ids}):
        log.info("deleted %d clip(s) older than %.0f days", len(ids), keep_s / 86400)
        return set(ids)
    return set()


def _abandon(st, w, why):
    log.error("giving up on clip %s [%.0f-%.0f]: %s", w["ids"][0], w["start"], w["end"], why)
    st["abandoned"].append({"ids": w["ids"], "camera": w["camera"],
                            "start": w["start"], "end": w["end"], "why": why})
    st["done"].update(w["ids"])
    st["retry"].pop(w["ids"][0], None)


def _fail(st, w, now, why):
    """Count a failure; give the window up after MAX_ATTEMPTS. True if given up."""
    key = w["ids"][0]
    r = st["retry"].setdefault(key, {"attempts": 0, "next_at": 0})
    r["attempts"] += 1
    if r["attempts"] >= MAX_ATTEMPTS:
        _abandon(st, w, f"{why}, after {r['attempts']} attempts")
        return True
    r["next_at"] = now + backoff_s(r["attempts"])
    log.warning("clip for %s failed (%s); attempt %d, next try in %d s",
                key, why, r["attempts"], backoff_s(r["attempts"]))
    return False


def _reject(st, call, eid):
    """Delete a broken export; if the delete fails, never trust it again.

    A failed delete is tried again on each poll while the export still exists
    (_retry_rejected).
    """
    if not _try(call, "POST", "/api/exports/delete", {"ids": [eid]}):
        if eid not in st["rejected"]:
            st["rejected"] = (st["rejected"] + [eid])[-200:]


def _retry_rejected(st, call, exports):
    """Delete rejected exports that still exist; forget ids that are gone.

    Returns the ids deleted now. They are still in this poll's export list,
    so the caller must go on treating them as rejected until the next poll.
    """
    present = {e["id"] for e in exports}
    keep, deleted = [], set()
    for eid in st["rejected"]:
        if eid not in present:
            continue
        if _try(call, "POST", "/api/exports/delete", {"ids": [eid]}):
            deleted.add(eid)
        else:
            keep.append(eid)
    st["rejected"] = keep
    return deleted


def _job_status(call, eid):
    """The job's status, None if Frigate has no such job, "unknown" on error."""
    try:
        return (call("GET", f"/api/jobs/export/{eid}") or {}).get("status")
    except urllib.error.HTTPError as e:
        return None if e.code == 404 else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def _verify_pending(st, call, file_info, exports, now):
    by_id = {e["id"]: e for e in exports}
    for eid, p in list(st["pending"].items()):
        e = by_id.get(eid)
        if e is None:
            status = _job_status(call, eid)
            if status in LIVE_JOB and now - p.get("since", now) > PENDING_MAX_S:
                del st["pending"][eid]
                _fail(st, p, now, f"job still {status} after {PENDING_MAX_S // 3600} h")
                continue
            if status in LIVE_JOB or status == "unknown":
                continue  # queued, running, or finishing: no row yet
            del st["pending"][eid]
            _fail(st, p, now, f"job {status or 'gone'}")
            continue
        if e.get("in_progress"):
            continue
        state, seconds = file_info(e["video_path"])
        if state == "unreadable":
            log.warning("cannot read %s yet; leaving it", e["video_path"])
            continue
        del st["pending"][eid]
        if state == "ok":
            st["done"].update(p["ids"])
            st["retry"].pop(p["ids"][0], None)
            name = format_name(p["camera"], p["start"], p["end"], p["labels"], seconds)
            if e["name"] != name:
                _try(call, "PATCH", f"/api/export/{eid}/rename", {"name": name})
            log.info("clip %s verified, %.0f s", eid, seconds)
        else:
            _reject(st, call, eid)
            _fail(st, p, now, "broken file")


def _backfill(st, call, file_info, exports, skip_ids, limit=10):
    """Finished event clips without d=: add their length, or delete them if broken."""
    for e in exports:
        if limit <= 0:
            break
        tag = parse_tag(e["name"])
        if not tag or tag["d"] is not None or e.get("in_progress") or e["id"] in skip_ids:
            continue
        state, seconds = file_info(e["video_path"])
        if state == "ok":
            name = format_name(tag["c"], tag["s"], tag["e"], _labels_of(e["name"]), seconds)
            _try(call, "PATCH", f"/api/export/{e['id']}/rename", {"name": name})
        elif state == "bad":
            log.warning("deleting broken clip %s so it is cut again", e["id"])
            _reject(st, call, e["id"])
        limit -= 1


def run_once(st, call=api, file_info=mp4_info, now=None):
    now = time.time() if now is None else now
    query = urllib.parse.urlencode({"after": now - LOOKBACK})
    items = call("GET", f"/api/review?{query}") or []
    exports = call("GET", "/api/exports") or []
    # Queued and running jobs have no export row yet. Without them, a request
    # whose reply was lost would be sent again. If this fails, request nothing.
    jobs = call("GET", "/api/jobs/export") or []
    _verify_pending(st, call, file_info, exports, now)
    rejected = set(st["rejected"]) | _retry_rejected(st, call, exports)
    _backfill(st, call, file_info, exports, set(st["pending"]) | rejected)
    gone = _expire(st, call, exports, now)
    exports = [e for e in exports if e["id"] not in gone]

    # What exists or is on its way, per camera, from Frigate's own list.
    prior = {}
    for e in exports:
        t = parse_tag(e["name"])
        if t and e["id"] not in rejected:
            prior.setdefault(t["c"], []).append((t["s"], t["e"]))
    for j in jobs:
        t = parse_tag(j.get("name"))
        if t:
            prior.setdefault(t["c"], []).append((t["s"], t["e"]))
    for p in st["pending"].values():
        prior.setdefault(p["camera"], []).append((p["start"], p["end"]))
    covered = {it["id"] for it in items
               if any(s <= it["start_time"] <= e for s, e in prior.get(it["camera"], []))}

    blocked = set()  # cameras that wait this poll, so no window jumps an earlier one
    for w in plan_windows(items, st["done"] | covered, prior, now):
        cam, key = w["camera"], w["ids"][0]
        if cam in blocked:
            continue
        if w["start"] >= w["end"]:
            st["done"].update(w["ids"])
            continue
        if w["start"] < now - min(LOOKBACK, RECORD_KEEP_S) + ABANDON_MARGIN_S:
            _abandon(st, w, f"about to leave the {LOOKBACK / 3600:.0f} h view")
            continue
        r = st["retry"].get(key)
        if r and r["next_at"] > now:
            blocked.add(cam)
            continue

        name = format_name(cam, w["start"], w["end"], w["labels"])
        path = (f"/api/export/{urllib.parse.quote(cam)}"
                f"/start/{w['start']:.0f}/end/{w['end']:.0f}")
        try:
            resp = call("POST", path, {"source": "recordings", "name": name})
        except urllib.error.HTTPError as e:
            if e.code == 503:
                log.info("export queue full, retrying next poll")
                break
            if 400 <= e.code < 500:
                _abandon(st, w, f"Frigate refused it (HTTP {e.code}: {e.reason})")
                continue
            if not _fail(st, w, now, f"HTTP {e.code}"):
                blocked.add(cam)
            continue
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if not _fail(st, w, now, str(e)):
                blocked.add(cam)
            continue
        eid = (resp or {}).get("export_id")
        if not eid:
            if not _fail(st, w, now, f"no export id in reply: {resp}"):
                blocked.add(cam)
            continue
        st["pending"][eid] = {"camera": cam, "start": w["start"], "end": w["end"],
                              "ids": w["ids"], "labels": sorted(w["labels"]), "since": now}
        log.info("requested %s [%d s] as %s", name, w["end"] - w["start"], eid)

    st["done"] = prune_done(st["done"], now, LOOKBACK + 6 * 3600)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    st = load_state()
    last = None
    log.info("watching %s, pad %d s, settle %d s, view %d h", FRIGATE, PAD, SETTLE, LOOKBACK / 3600)
    while True:
        try:
            run_once(st)
            last = save_state(st, last)
        except Exception as e:  # Frigate restarting or not up yet
            log.warning("poll failed: %s", e)
        time.sleep(POLL)


if __name__ == "__main__":
    main()

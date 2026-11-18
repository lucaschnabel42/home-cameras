"""Tests for plan_windows. Run: python -m pytest exporter -q"""

from export_clips import format_name, plan_windows

PAD, SETTLE = 150, 60


def item(id, start, end, cam="wyze", objects=("person",)):
    return {"id": id, "camera": cam, "start_time": start, "end_time": end,
            "data": {"objects": list(objects)}}


def plan(items, now, done=(), last_end=None):
    """last_end={cam: t} means one prior clip on cam that ends at t."""
    prior = {cam: [(0, t)] for cam, t in (last_end or {}).items()}
    return plan_windows(items, set(done), prior, now, PAD, SETTLE)


def test_single_event_padded_both_sides():
    (w,) = plan([item("a", 1000, 1020)], now=1020 + PAD + SETTLE)
    assert (w["start"], w["end"], w["ids"]) == (1000 - PAD, 1020 + PAD, ["a"])


def test_not_ready_until_padding_and_settle_pass():
    assert plan([item("a", 1000, 1020)], now=1020 + PAD + SETTLE - 1) == []


def test_in_progress_event_blocks():
    assert plan([item("a", 1000, None)], now=10**9) == []


def test_overlapping_events_merge_into_one_clip():
    items = [item("b", 1200, 1210, objects=("car",)), item("a", 1000, 1020)]
    (w,) = plan(items, now=10**9)
    assert (w["start"], w["end"]) == (1000 - PAD, 1210 + PAD)
    assert w["ids"] == ["a", "b"] and w["labels"] == {"person", "car"}


def test_far_apart_events_make_two_clips():
    ws = plan([item("a", 1000, 1020), item("b", 2000, 2010)], now=10**9)
    assert [w["ids"] for w in ws] == [["a"], ["b"]]


def test_in_progress_event_holds_back_later_windows_only():
    ws = plan([item("a", 1000, 1020), item("b", 5000, None)], now=10**9)
    assert [w["ids"] for w in ws] == [["a"]]


def test_clip_keeps_full_lead_in_over_previous_clip():
    # round 3: a trimmed clip held as little as 60 s before the detection
    (w,) = plan([item("b", 1300, 1310)], now=10**9, last_end={"wyze": 1200})
    assert w["start"] == 1300 - PAD and w["end"] == 1310 + PAD


def test_done_ids_skipped():
    assert plan([item("a", 1000, 1020)], now=10**9, done={"a"}) == []


def test_cameras_independent():
    ws = plan([item("a", 1000, 1020, cam="x"), item("b", 1000, 1020, cam="y")],
              now=10**9, last_end={"x": 5000})
    by = {w["camera"]: w for w in ws}
    assert by["x"]["start"] == by["y"]["start"] == 1000 - PAD



def test_format_name_is_short_and_sorted():
    name = format_name("living_room_cam", 1000.4, 1300.6, {"person", "car"})
    assert name == "wc1;k=e;c=living_room_cam;s=1000;e=1301;l=car,person"
    assert len(name) <= 100


def test_format_name_worst_case_fits_db_column():
    name = format_name("c" * 20, 1791956307.9, 1791999999.9,
                       {"person", "car", "dog", "cat", "bird"})
    assert len(name) <= 100


# ---------------------------------------------------------------------------
# run_once: verification, retries, adoption (round 1 review, 2026-10-15)
# ---------------------------------------------------------------------------
import struct
import urllib.error

import export_clips
from export_clips import (backoff_s, mp4_info, new_state, parse_tag, prune_done,
                          run_once)


class FakeApi:
    """Stands in for Frigate. Exports appear when POSTed; tests change them."""

    def __init__(self, reviews):
        self.reviews = reviews
        self.exports = {}
        self.calls = []
        self.fail_post = None  # an exception instance to raise on POST
        self.fail_change = None  # an exception for rename/delete
        self.jobs = {}  # export id -> status, for exports still queued (no row yet)
        self.active = []  # job dicts that /api/jobs/export lists (queued or running)
        self.fail_jobs = None  # an exception for GET /api/jobs/export
        self.n = 0

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET" and path.startswith("/api/review"):
            return self.reviews
        if method == "GET" and path == "/api/exports":
            return list(self.exports.values())
        if method == "GET" and path == "/api/jobs/export":
            if self.fail_jobs:
                raise self.fail_jobs
            return list(self.active)
        if method == "GET" and path.startswith("/api/jobs/export/"):
            eid = path.rsplit("/", 1)[1]
            if eid in self.jobs:
                return {"id": eid, "status": self.jobs[eid]}
            raise urllib.error.HTTPError(path, 404, "Job not found", None, None)
        if method == "POST" and path.startswith("/api/export/"):
            if self.fail_post:
                raise self.fail_post
            self.n += 1
            eid = f"x{self.n}"
            cam = path.split("/")[3]
            self.exports[eid] = {"id": eid, "camera": cam, "name": body["name"],
                                 "in_progress": True,
                                 "video_path": f"/media/frigate/exports/{eid}.mp4"}
            return {"success": True, "export_id": eid, "status": "queued"}
        if method in ("PATCH", "POST") and self.fail_change and (path.endswith("/rename") or path.endswith("/delete")):
            raise self.fail_change
        if method == "PATCH" and path.endswith("/rename"):
            eid = path.split("/")[3]
            self.exports[eid]["name"] = body["name"]
            return {"success": True}
        if method == "POST" and path == "/api/exports/delete":
            for eid in body["ids"]:
                self.exports.pop(eid, None)
            return {"success": True}
        raise AssertionError(f"unexpected call {method} {path}")

    def posts(self):
        return [p for m, p, _ in self.calls if m == "POST" and p.startswith("/api/export/")]

    def finish(self, eid):
        self.exports[eid]["in_progress"] = False


def good_file(path):
    return "ok", 321.4


def bad_file(path):
    return "bad", None


NOW = 1_792_000_000  # a real unix time; small values go negative across 3 days


def test_post_is_pending_until_verified_then_done_with_real_length():
    api = FakeApi([item("a", 1000 + NOW - 5000, 1020 + NOW - 5000)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    assert "a" not in st["done"] and len(st["pending"]) == 1
    api.finish("x1")
    run_once(st, api, good_file, NOW + 30)
    assert "a" in st["done"] and st["pending"] == {}
    assert parse_tag(api.exports["x1"]["name"])["d"] == 321  # renamed with the real length


def test_failed_export_row_gone_is_retried_not_lost():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    api.exports.clear()  # Frigate's ffmpeg failed and it deleted the row
    run_once(st, api, good_file, NOW + 30)
    assert "a" not in st["done"]
    run_once(st, api, good_file, NOW + 30 + backoff_s(1) + 1)
    assert len(api.posts()) == 2  # asked again


def test_corrupt_file_is_deleted_and_retried():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    api.finish("x1")
    run_once(st, api, bad_file, NOW + 30)
    assert "x1" not in api.exports and "a" not in st["done"]
    run_once(st, api, good_file, NOW + 30 + backoff_s(1) + 1)
    assert len(api.posts()) == 2


def test_failure_on_earlier_window_does_not_skip_it():
    # review finding F2: a failure on window A, success on B, must not drop A
    api = FakeApi([item("a", NOW - 9000, NOW - 8980), item("b", NOW - 4000, NOW - 3980)])
    api.fail_post = urllib.error.URLError("frigate down")
    st = new_state()
    run_once(st, api, good_file, NOW)
    assert len(api.posts()) == 1  # stopped at A; B waits behind it
    api.fail_post = None
    run_once(st, api, good_file, NOW + backoff_s(1) + 1)
    starts = [int(p.split("/")[5]) for p in api.posts()[1:]]
    assert starts[0] == NOW - 9000 - PAD  # A first, at its own start


def test_existing_export_with_same_window_is_adopted_not_duplicated():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    st2 = new_state()  # the exporter restarted before saving its state
    run_once(st2, api, good_file, NOW + 30)
    assert len(api.posts()) == 1  # the export in flight covers the event


def test_transient_failure_retries_then_gives_up_and_unblocks_later_windows():
    # round 2: one bad window must not hold later clips for two days
    api = FakeApi([item("a", NOW - 9000, NOW - 8980), item("b", NOW - 4000, NOW - 3980)])
    api.fail_post = urllib.error.HTTPError("u", 500, "boom", None, None)
    st = new_state()
    t = NOW
    for _ in range(export_clips.MAX_ATTEMPTS):
        run_once(st, api, good_file, t)
        t += backoff_s(st["retry"].get("a", {}).get("attempts", export_clips.MAX_ATTEMPTS)) + 1
    assert "a" in st["done"] and st["abandoned"][0]["ids"] == ["a"]
    assert t - NOW < 2 * 3600  # bounded: about half an hour of retries
    api.fail_post = None
    run_once(st, api, good_file, t)
    assert int(api.posts()[-1].split("/")[5]) == NOW - 4000 - PAD  # b goes ahead


def test_no_recordings_reply_is_given_up_at_once_without_blocking():
    api = FakeApi([item("a", NOW - 9000, NOW - 8980), item("b", NOW - 4000, NOW - 3980)])
    calls = {"n": 0}
    real = api.__call__

    def call(method, path, body=None):
        if method == "POST" and path.startswith("/api/export/") and calls["n"] == 0:
            calls["n"] += 1
            api.calls.append((method, path, body))
            raise urllib.error.HTTPError(path, 400, "No recordings found for time range", None, None)
        return real(method, path, body)

    st = new_state()
    run_once(st, call, good_file, NOW)
    assert "a" in st["done"] and len(api.posts()) == 2  # b requested in the same poll


def test_queued_export_without_a_row_stays_pending():
    # Frigate creates the row only when a worker starts the job
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    del api.exports["x1"]
    api.jobs["x1"] = "queued"
    run_once(st, api, good_file, NOW + 30)
    assert list(st["pending"]) == ["x1"] and len(api.posts()) == 1


def test_failed_job_is_retried():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    del api.exports["x1"]
    api.jobs["x1"] = "failed"
    run_once(st, api, good_file, NOW + 30)
    assert st["pending"] == {} and st["retry"]["a"]["attempts"] == 1


def test_unreadable_file_is_never_deleted():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    api.finish("x1")
    run_once(st, api, lambda p: ("unreadable", None), NOW + 30)
    assert "x1" in api.exports and "x1" in st["pending"]


def test_failed_delete_does_not_loop_on_the_corrupt_export():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    api.finish("x1")
    api.fail_change = urllib.error.URLError("down")
    run_once(st, api, bad_file, NOW + 30)
    api.fail_change = None
    run_once(st, api, good_file, NOW + 30 + backoff_s(1) + 1)
    assert "x1" not in st["pending"]
    assert "x1" not in api.exports and st["rejected"] == []  # the delete was tried again
    assert len(api.posts()) == 2  # a fresh export, not the corrupt one adopted


def test_failed_rename_does_not_stop_new_clips():
    api = FakeApi([item("b", NOW - 4000, NOW - 3980)])
    api.exports["old"] = {"id": "old", "camera": "wyze", "in_progress": False,
                          "name": "wc1;k=e;c=wyze;s=1000;e=1300;l=person",
                          "video_path": "/media/frigate/exports/old.mp4"}
    api.fail_change = urllib.error.URLError("down")
    run_once(new_state(), api, good_file, NOW)
    assert len(api.posts()) == 1


def test_lost_state_file_makes_no_duplicates():
    # events covered by an existing clip are done, as the app sees them
    api = FakeApi([item("a", NOW - 4000, NOW - 3980), item("b", NOW - 3900, NOW - 3890)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    api.finish("x1")
    run_once(st, api, good_file, NOW + 30)
    run_once(new_state(), api, good_file, NOW + 60)  # state lost
    assert len(api.posts()) == 1


def test_backfill_deletes_a_corrupt_unverified_clip_so_it_is_cut_again():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    api.exports["old"] = {"id": "old", "camera": "wyze", "in_progress": False,
                          "name": f"wc1;k=e;c=wyze;s={NOW - 4000 - PAD};e={NOW - 3980 + PAD};l=person",
                          "video_path": "/media/frigate/exports/old.mp4"}
    st = new_state()
    run_once(st, api, bad_file, NOW)
    assert "old" not in api.exports
    run_once(st, api, good_file, NOW + 30)
    assert len(api.posts()) == 1


def test_window_older_than_recordings_is_abandoned_and_logged():
    old = NOW - export_clips.RECORD_KEEP_S
    api = FakeApi([item("a", old, old + 20)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    assert "a" in st["done"] and st["abandoned"] and api.posts() == []


def test_backoff_grows_and_caps():
    assert backoff_s(1) < backoff_s(2) < backoff_s(3)
    assert backoff_s(50) == export_clips.MAX_BACKOFF_S


def test_event_longer_than_cap_is_clipped():
    # Frigate closes open events at restart time; a power cut makes one hours long.
    (w,) = plan([item("a", 1000, 1000 + 6 * 3600)], now=10**9)
    assert w["end"] == 1000 + export_clips.MAX_EVENT_S + PAD


def test_prune_done_drops_ids_older_than_lookback():
    now = 1_792_000_000  # review ids start with the event's unix time
    done = {f"{now - 10:.6f}-new", f"{now - 400000:.6f}-old", "weird-id"}
    assert prune_done(done, now, 3600) == {f"{now - 10:.6f}-new", "weird-id"}


def test_tag_round_trip_with_duration():
    name = format_name("cam", 1000, 1300, {"person"}, duration=287.6)
    assert name.endswith(";d=288") and len(name) <= 100
    assert parse_tag(name) == {"c": "cam", "s": 1000, "e": 1300, "d": 288}
    assert parse_tag("not a tag") is None


def _mp4(duration_units, timescale=1000, version=0):
    if version == 0:
        mvhd_body = struct.pack(">B3xIIII", 0, 0, 0, timescale, duration_units)
    else:
        mvhd_body = struct.pack(">B3xQQIQ", 1, 0, 0, timescale, duration_units)
    mvhd = struct.pack(">I4s", 8 + len(mvhd_body), b"mvhd") + mvhd_body
    moov = struct.pack(">I4s", 8 + len(mvhd), b"moov") + mvhd
    ftyp = struct.pack(">I4s", 16, b"ftyp") + b"isom\x00\x00\x02\x00"
    mdat = struct.pack(">I4s", 12, b"mdat") + b"\x00" * 4
    return ftyp + mdat + moov


def test_mp4_info_reads_duration(tmp_path):
    p = tmp_path / "a.mp4"
    p.write_bytes(_mp4(287_600))
    assert mp4_info(str(p)) == ("ok", 287.6)
    p.write_bytes(_mp4(90_000 * 60, timescale=90_000, version=1))
    assert mp4_info(str(p)) == ("ok", 60.0)


def test_mp4_info_tells_corrupt_from_unreadable(tmp_path):
    p = tmp_path / "b.mp4"
    p.write_bytes(_mp4(1000)[:-30])  # truncated: no moov, like a killed ffmpeg
    assert mp4_info(str(p)) == ("bad", None)
    # a file that cannot be opened is "unreadable", never "bad": it must not be deleted
    assert mp4_info(str(tmp_path / "none.mp4")) == ("unreadable", None)


def test_finished_clip_missing_length_is_backfilled():
    # Frigate can overwrite a rename made right after its job finishes, and
    # clips from before 2026-10-15 have no d= at all.
    api = FakeApi([])
    api.exports["old"] = {"id": "old", "camera": "cam", "in_progress": False,
                          "name": "wc1;k=e;c=cam;s=1000;e=1300;l=person",
                          "video_path": "/media/frigate/exports/old.mp4"}
    api.exports["saved"] = {"id": "saved", "camera": "cam", "in_progress": False,
                            "name": "wc1;k=s;c=cam;s=1000;e=1300;l=",
                            "video_path": "/media/frigate/exports/saved.mp4"}
    st = new_state()
    run_once(st, api, good_file, NOW)
    assert parse_tag(api.exports["old"]["name"])["d"] == 321
    assert api.exports["saved"]["name"].endswith("l=")  # saved clips are left alone
    n = len(api.calls)
    run_once(st, api, good_file, NOW + 30)
    assert not [c for c in api.calls[n:] if c[0] == "PATCH"]  # nothing left to rename


# ---------------------------------------------------------------------------
# Review round 3 (2026-10-16)
# ---------------------------------------------------------------------------
import pytest

from export_clips import load_state, save_state


@pytest.mark.parametrize("text", ["", '{"done": ["abc', "[1, 2]"])
def test_corrupt_state_file_starts_empty(tmp_path, monkeypatch, text):
    # a power cut can leave the file empty or cut short; the exporter must not crash-loop
    f = tmp_path / "s.json"
    f.write_text(text)
    monkeypatch.setattr(export_clips, "STATE_FILE", str(f))
    assert load_state() == new_state()


def test_state_written_only_when_changed(tmp_path, monkeypatch):
    f = tmp_path / "s.json"
    monkeypatch.setattr(export_clips, "STATE_FILE", str(f))
    st = new_state()
    last = save_state(st)
    f.unlink()
    assert save_state(st, last) == last and not f.exists()  # unchanged: no write
    st["done"].add("a")
    save_state(st, last)
    assert load_state()["done"] == {"a"}


def test_mp4_info_header_cut_inside_a_box_is_bad_not_an_exception(tmp_path):
    p = tmp_path / "c.mp4"
    ftyp = struct.pack(">I4s", 16, b"ftyp") + b"isom\x00\x00\x02\x00"
    p.write_bytes(ftyp + struct.pack(">I4s", 1, b"mdat") + b"\x00\x00")  # 64-bit size cut short
    assert mp4_info(str(p)) == ("bad", None)
    mvhd = struct.pack(">I4s", 108, b"mvhd") + b"\x00"  # mvhd cut after its version byte
    moov = struct.pack(">I4s", 8 + len(mvhd), b"moov") + mvhd
    p.write_bytes(ftyp + moov)
    assert mp4_info(str(p)) == ("bad", None)


def test_queued_job_whose_reply_was_lost_is_not_sent_twice():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    real = api.__call__

    def call(method, path, body=None):
        if method == "POST" and path.startswith("/api/export/"):
            real(method, path, body)  # Frigate queued it ...
            eid = f"x{api.n}"
            del api.exports[eid]  # ... no row yet ...
            api.active.append({"id": eid, "status": "queued", "name": body["name"]})
            raise TimeoutError("timed out")  # ... and the reply was lost
        return real(method, path, body)

    st = new_state()
    run_once(st, call, good_file, NOW)
    run_once(st, call, good_file, NOW + backoff_s(1) + 1)
    assert len(api.posts()) == 1


def test_jobs_list_error_requests_nothing():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    api.fail_jobs = urllib.error.URLError("down")
    st = new_state()
    with pytest.raises(urllib.error.URLError):
        run_once(st, api, good_file, NOW)
    assert api.posts() == []


def test_pending_job_stuck_for_hours_counts_as_a_failure():
    api = FakeApi([item("a", NOW - 4000, NOW - 3980)])
    st = new_state()
    run_once(st, api, good_file, NOW)
    del api.exports["x1"]
    api.jobs["x1"] = "running"
    run_once(st, api, good_file, NOW + 60)
    assert "x1" in st["pending"]  # still running: wait
    run_once(st, api, good_file, NOW + export_clips.PENDING_MAX_S + 60)
    assert "x1" not in st["pending"] and st["retry"]["a"]["attempts"] == 1


def test_long_chain_of_events_is_split_below_frigates_segment_limit():
    # one event every 250 s for 3 h: the padded windows all touch
    items = [item(f"e{i:03d}", 1000 + 250 * i, 1010 + 250 * i) for i in range(44)]
    ws = plan(items, now=10**9)
    assert len(ws) >= 2
    assert all(w["end"] - w["start"] <= export_clips.MAX_WINDOW_S for w in ws)
    assert sorted(i for w in ws for i in w["ids"]) == [it["id"] for it in items]


def test_open_event_still_merges_with_the_window_before():
    ws = plan([item("a", 1000, 1020), item("b", 1100, None)], now=10**9)
    assert ws == []  # one window, waiting for b to end


def test_sound_labels_join_the_clip_labels():
    # Sound events (a dog barking, a smoke alarm) are review items too.
    it = item("a", 1000, 1020, objects=())
    it["data"]["audio"] = ["bark"]
    (w,) = plan([it, item("b", 1100, 1110)], now=10**9)
    assert w["labels"] == {"bark", "person"}


# --- CLIP_KEEP_DAYS: old event clips go ------------------------------------------------

def tagged(eid, end, cam="cam", done=True, in_progress=False):
    name = f"wc1;k=e;c={cam};s={end - 300:.0f};e={end:.0f};l=person" + (";d=300" if done else "")
    return {"id": eid, "camera": cam, "name": name, "in_progress": in_progress,
            "video_path": f"/media/frigate/exports/{eid}.mp4"}


def test_expired_takes_only_finished_event_clips_older_than_the_limit():
    keep = 10 * 86400
    exports = [tagged("old", NOW - keep - 60), tagged("new", NOW - keep + 60),
               tagged("running", NOW - keep - 60, in_progress=True),
               {"id": "saved", "camera": "cam", "name": "My save", "in_progress": False},
               tagged("unchecked", NOW - keep - 60, done=False)]
    assert export_clips.expired(exports, keep, NOW, skip_ids=set()) == ["old", "unchecked"]
    assert export_clips.expired(exports, keep, NOW, skip_ids={"old"}) == ["unchecked"]
    assert export_clips.expired(exports, 0, NOW, skip_ids=set()) == []


def test_a_keep_shorter_than_the_view_is_refused():
    # A clip deleted while its event is still in the review view would be cut again.
    assert export_clips.safe_keep_s(1 * 86400) == 0
    assert export_clips.safe_keep_s(0) == 0
    assert export_clips.safe_keep_s(3 * 86400) == 3 * 86400


def test_run_once_deletes_old_clips_and_cuts_none_again(monkeypatch):
    monkeypatch.setattr(export_clips, "CLIP_KEEP_S", 10 * 86400)
    api = FakeApi([])
    api.exports["old"] = tagged("old", NOW - 11 * 86400)
    api.exports["new"] = tagged("new", NOW - 2 * 86400)
    st = new_state()
    run_once(st, api, good_file, NOW)
    assert "old" not in api.exports and "new" in api.exports
    assert api.posts() == []


def test_with_no_limit_nothing_is_deleted(monkeypatch):
    monkeypatch.setattr(export_clips, "CLIP_KEEP_S", 0)
    api = FakeApi([])
    api.exports["old"] = tagged("old", NOW - 400 * 86400)
    run_once(new_state(), api, good_file, NOW)
    assert "old" in api.exports

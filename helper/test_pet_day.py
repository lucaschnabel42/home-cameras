"""Tests for pet_day.py on synthetic arrays. Run: python -m pytest -q helper"""

import json
import time

import cv2
import numpy as np
import pytest

import pet
import pet_day

PET = pet.Pet("Rex", "living_room_cam")

H, W = 90, 160
NOW = 1_800_000_000.0


def gray(v=100):
    return np.full((H, W, 3), v, np.uint8)


def colour():
    f = np.zeros((H, W, 3), np.uint8)
    f[..., 0], f[..., 1], f[..., 2] = 40, 120, 200  # orange-ish: saturated
    return f


def with_block(base, box, bgr):
    """base with a solid block over the normalised box (x, y, w, h)."""
    f = base.copy()
    x, y, w, h = box
    hh, ww = f.shape[:2]
    f[int(y * hh):int((y + h) * hh), int(x * ww):int((x + w) * ww)] = bgr
    return f


def summary(title, text=""):
    return {"title": title, "summary": text}


def review(rid, start, objects=("dog",), audio=(), detections=(), end=None, cam="living_room_cam"):
    return {"id": rid, "camera": cam, "start_time": start,
            "end_time": start + 30 if end is None else end,
            "data": {"objects": list(objects), "audio": list(audio),
                     "detections": list(detections)}}


def event(eid, label, start, end, box, path=(), snap=None, cam="living_room_cam"):
    return {"id": eid, "label": label, "camera": cam, "start_time": start, "end_time": end,
            "data": {"box": list(box) if box else None, "path_data": [list(p) for p in path],
                     "snapshot_frame_time": snap}}


# --- lighting -------------------------------------------------------------------

def test_lighting_split():
    assert pet_day.is_night(gray()) is True
    assert pet_day.is_night(colour()) is False
    nearly_grey = gray()
    nearly_grey[..., 2] = 110  # saturation about 23 on 0..255
    assert pet_day.is_night(nearly_grey) is False


# --- kinds and place names --------------------------------------------------------

@pytest.mark.parametrize("title, text, kind", [
    ("Rex naps on the couch", "Rex remains curled up. A person walks past in the background.",
     "nap"),
    ("Rex relaxes on the couch", "Rex lies on the couch.", "rest"),
    ("Rex relaxes on the floor", "Rex lies on the floor near the couch.", "floor"),
    ("Rex sits on the rug", "", "floor"),
    ("Rex walks across the room", "Rex walks from the kitchen to the couch.", "walk"),
    ("Rex plays with ball", "Rex chases a ball thrown by a person.", "play"),
    ("Rex rests on the couch", "A person pets Rex on the couch.", "with-person"),
    ("Rex follows person", "Rex follows a person across the room.", "with-person"),
    ("Person walks into kitchen", "A person walks into the kitchen. Rex remains on the couch, "
     "undisturbed.", "rest"),
    ("Living room ambiance changes", "The lighting shifts from white to purple.", "other"),
    ("Rex barks at the door", "Rex barks.", "bark"),
])
def test_moment_kind_from_the_summary(title, text, kind):
    assert pet_day.moment_kind(review("r", 0), summary(title, text), PET) == kind


def test_a_person_walking_past_is_not_with_person():
    s = summary("Rex naps on the couch", "A person walks past in the background.")
    assert pet_day.moment_kind(review("r", 0), s, PET) == "nap"


def test_heard_bark_is_a_bark_even_without_a_summary():
    assert pet_day.moment_kind(review("r", 0, audio=["bark"]), None, PET) == "bark"
    assert pet_day.moment_kind(review("r", 0), None, PET) is None


def test_place_name_is_the_commonest_place_word():
    assert pet_day.place_name([summary("Rex naps on the couch"),
                          summary("Rex rests", "He lies on the floor near the sofa.")]) == "couch"
    assert pet_day.place_name([summary("Rex relaxes on the floor", "Near the couch.")]) == "floor"
    assert pet_day.place_name([summary("Rex moves around", "He looks about.")]) is None
    assert pet_day.place_name([]) is None


# --- geometry -----------------------------------------------------------------------

def test_crop_is_16_9_inside_the_frame_and_above_the_clock():
    for box in [(0.4, 0.5, 0.18, 0.13), (0.0, 0.85, 0.1, 0.15), (0.9, 0.0, 0.1, 0.1),
                (0.0, 0.0, 1.0, 1.0)]:
        x0, y0, x1, y1 = pet_day.crop_rect(box)
        assert 0 <= x0 < x1 <= 1 + 1e-9 and 0 <= y0 < y1 <= pet_day.CLOCK_BAND + 1e-9
        assert (x1 - x0) * 16 / ((y1 - y0) * 9) == pytest.approx(16 / 9)


def test_crop_holds_the_box_with_a_margin():
    box = (0.4, 0.4, 0.2, 0.1)
    x0, y0, x1, y1 = pet_day.crop_rect(box)
    assert x0 <= 0.4 - 0.2 * pet_day.CROP_MARGIN + 1e-9 and x1 >= 0.6 + 0.2 * pet_day.CROP_MARGIN - 1e-9
    assert y0 <= 0.4 and y1 >= 0.5


def test_small_box_gets_the_minimum_crop():
    x0, _, x1, _ = pet_day.crop_rect((0.5, 0.5, 0.02, 0.02))
    assert x1 - x0 == pytest.approx(pet_day.MIN_CROP)


def test_meets():
    assert pet_day.meets((0, 0, 0.5, 0.5), (0.4, 0.4, 1, 1))
    assert not pet_day.meets((0, 0, 0.5, 0.5), (0.5, 0, 1, 1))  # touching edges only


# --- moments and the person rule -------------------------------------------------------

def test_moment_time_is_the_snapshot_frame_time_with_its_box():
    e = event("d1", "dog", 100, 200, (0.4, 0.5, 0.2, 0.1), path=[([0.1, 0.9], 120)], snap=150)
    (m,) = pet_day.pet_moments([review("r1", 100, detections=["d1"], end=200)], [e],
                          "living_room_cam", "dog", 0, 1000)
    assert m == {"t": 150, "box": (0.4, 0.5, 0.2, 0.1), "review": "r1"}


def test_snapshot_outside_the_item_falls_back_to_a_path_point_inside_it():
    e = event("d1", "dog", 100, 900, (0.4, 0.5, 0.2, 0.1),
              path=[([0.3, 0.9], 110), ([0.7, 0.8], 520), ([0.6, 0.8], 800)], snap=150)
    (m,) = pet_day.pet_moments([review("r1", 500, detections=["d1"], end=560)], [e],
                          "living_room_cam", "dog", 0, 1000)
    assert m["t"] == 520
    assert m["box"] == pytest.approx((0.6, 0.7, 0.2, 0.1))


def test_only_dog_items_on_the_camera_inside_the_day_are_moments():
    d = event("d1", "dog", 100, 200, (0.4, 0.5, 0.2, 0.1), snap=150)
    p = event("p1", "person", 300, 400, (0.4, 0.5, 0.2, 0.1), snap=350)
    reviews = [review("r1", 100, detections=["d1"], end=200),
               review("r2", 300, objects=["person"], detections=["p1"], end=400),
               review("r3", 100, detections=["d1"], end=200, cam="front_porch_cam"),
               review("r4", 2000, detections=["d1"])]
    assert [m["review"] for m in pet_day.pet_moments(reviews, [d, p], "living_room_cam", "dog", 0, 1000)] \
        == ["r1"]


def test_moment_whose_crop_meets_a_person_box_is_dropped():
    rex = {"t": 1000, "box": (0.4, 0.5, 0.2, 0.1), "review": "r1"}
    alone = {"t": 5000, "box": (0.4, 0.5, 0.2, 0.1), "review": "r2"}
    beside = event("p1", "person", 900, 1100, (0.62, 0.3, 0.1, 0.5), snap=1000)
    far = event("p2", "person", 4900, 5100, (0.0, 0.0, 0.05, 0.1), snap=5000)
    assert pet_day.keep_without_people([rex, alone], [beside, far]) == [alone]


def test_person_box_follows_the_path():
    p = event("p1", "person", 0, None, (0.0, 0.0, 0.1, 0.2),
              path=[([0.05, 0.2], 10), ([0.85, 0.9], 500)])
    assert pet_day.person_boxes([p], 490) == [pytest.approx((0.8, 0.7, 0.9, 0.9))]
    assert pet_day.person_boxes([dict(p, end_time=100)], 490) == []


# --- places, minutes, ribbon, barks ----------------------------------------------------

def test_cluster_joins_points_under_the_radius():
    labels, centres = pet_day.cluster([(0.5, 0.5), (0.55, 0.5), (0.9, 0.9), (0.52, 0.52)])
    assert labels == [0, 0, 1, 0]
    assert centres[0] == pytest.approx((0.5233, 0.5067), abs=1e-3)


def test_minutes_fill_gaps_of_up_to_30_min_at_one_place():
    box = (0.4, 0.4, 0.2, 0.2)  # centre (0.5, 0.5)
    evs = [event("a", "dog", 0, 120, box), event("b", "dog", 25 * 60, 25 * 60 + 60, box),
           event("c", "dog", 100 * 60, 100 * 60 + 60, box)]
    minutes = pet_day.minutes_seen(evs, "dog", [(0.5, 0.5)], 0, 86400, 86400)
    assert sorted(minutes) == list(range(0, 27)) + [100, 101]
    assert set(minutes.values()) == {0}


def test_no_filling_between_two_places():
    a, b = (0.0, 0.0, 0.2, 0.2), (0.7, 0.7, 0.2, 0.2)
    evs = [event("a", "dog", 0, 60, a), event("b", "dog", 10 * 60, 11 * 60, b)]
    minutes = pet_day.minutes_seen(evs, "dog", [(0.1, 0.1), (0.8, 0.8)], 0, 86400, 86400)
    assert minutes == {0: 0, 1: 0, 10: 1, 11: 1}


def test_minutes_far_from_every_place_are_not_counted():
    evs = [event("a", "dog", 0, 60, (0.0, 0.0, 0.1, 0.1))]
    assert pet_day.minutes_seen(evs, "dog", [(0.9, 0.9)], 0, 86400, 86400) == {}


def test_ribbon_runs():
    assert pet_day.ribbon({0: 0, 1: 0, 2: 1, 5: 1}, 1000) == [
        {"start": 1000, "end": 1120, "place": 0}, {"start": 1120, "end": 1180, "place": 1},
        {"start": 1300, "end": 1360, "place": 1}]


def test_barks_lose_frigates_padding_and_merge():
    evs = [event("b1", "bark", 1000, 1061, None), event("b2", "howl", 1000, 1100, None),
           event("b3", "bark", 5000, 5061, None, cam="front_porch_cam"),
           event("p", "person", 1000, 1100, (0, 0, 0.1, 0.1))]
    assert pet_day.barks(evs, "living_room_cam", 0, 10000, 10000) == [{"start": 1030, "end": 1070}]


# --- pictures -------------------------------------------------------------------------------

def test_moment_image_is_640_wide_without_the_green_box():
    frame = np.full((720, 1280, 3), 100, np.uint8)
    box = (0.4, 0.4, 0.2, 0.2)
    frame = with_block(frame, (0.45, 0.45, 0.1, 0.1), (255, 255, 255))
    cv2.rectangle(frame, (int(0.42 * 1280), int(0.42 * 720)), (int(0.58 * 1280), int(0.58 * 720)),
                  (0, 255, 0), 3)
    img = pet_day.moment_image(frame, box)
    assert img.shape == (360, 640, 3)
    green = (img[..., 1].astype(int) - img[..., 2].astype(int)) > 60
    assert not green.any()
    assert (img[180, 320] > 240).all()  # Rex in the middle


def test_moment_image_never_shows_the_clock_band():
    frame = np.full((720, 1280, 3), 100, np.uint8)
    frame[int(0.93 * 720):] = 255  # the clock band
    img = pet_day.moment_image(frame, (0.8, 0.85, 0.2, 0.15))
    assert img.max() < 200


def test_cut_clock_band():
    assert pet_day.cut_clock_band(np.zeros((720, 1280, 3), np.uint8)).shape == (670, 1280, 3)


def test_background_times_avoid_events():
    events = [{"start_time": 1000, "end_time": 2000}, {"start_time": 5000, "end_time": None}]
    times = pet_day.background_times(events, 0, 6000, step=100, margin=60)
    assert times and all(not (940 <= t <= 2060) and t < 4940 for t in times)
    assert times[:3] == [50, 150, 250]


def test_background_times_are_a_fixed_grid():
    """An hourly run must ask for the same times again, so the cache works."""
    early = pet_day.background_times([], 0, 7000, step=1800, margin=60)
    later = pet_day.background_times([], 0, 9000, step=1800, margin=60)
    assert later[:len(early)] == early


# --- the composite (the rest picture pastes one solid Rex) ------------------------------

def test_copy_lands_at_its_box_and_nowhere_else():
    bg = gray(100)
    box = (0.25, 0.25, 0.25, 0.25)
    frame = with_block(bg, box, (255, 255, 255))
    frame[0:10, 0:10] = 0  # a change outside the box must not be pasted
    out, kept = pet_day.composite(bg, [(frame, box)])
    assert kept == [0]
    cy, cx = int(0.375 * H), int(0.375 * W)
    assert (out[cy, cx] == 255).all()
    assert (out[0:10, 0:10] == 100).all()
    assert (out[H - 5:, W - 5:] == 100).all()


def test_newest_copy_is_opaque_and_older_ones_fade():
    bg = gray(100)
    boxes = [(0.05, 0.1, 0.2, 0.3), (0.4, 0.1, 0.2, 0.3), (0.75, 0.1, 0.2, 0.3)]
    copies = [(with_block(bg, b, (255, 255, 255)), b) for b in boxes]  # oldest first
    out, kept = pet_day.composite(bg, copies)
    centre = [out[int((b[1] + b[3] / 2) * H), int((b[0] + b[2] / 2) * W), 0] for b in boxes]
    assert centre[0] == pytest.approx(100 + 0.35 * 155, abs=2)
    assert centre[0] < centre[1] < centre[2] == 255


def test_newest_copy_is_drawn_on_top():
    bg = gray(100)
    box = (0.3, 0.3, 0.3, 0.3)
    old = with_block(bg, box, (0, 0, 255))
    new = with_block(bg, box, (255, 0, 0))
    out, _ = pet_day.composite(bg, [(old, box), (new, box)])
    assert tuple(out[int(0.45 * H), int(0.45 * W)]) == (255, 0, 0)


def test_copy_with_no_change_is_dropped():
    bg = gray(100)
    out, kept = pet_day.composite(bg, [(bg.copy(), (0.2, 0.2, 0.2, 0.2)),
                                  (with_block(bg, (0.6, 0.2, 0.2, 0.2), (255,) * 3),
                                   (0.6, 0.2, 0.2, 0.2))])
    assert kept == [1]


def test_green_motion_tag_is_not_pasted():
    """The camera burns a pure green box around motion; keep it out."""
    bg = gray(100)
    box = (0.25, 0.25, 0.3, 0.4)
    frame = with_block(bg, (0.3, 0.3, 0.2, 0.3), (255, 255, 255))
    x0, y0, x1, y1 = int(0.27 * W), int(0.27 * H), int(0.53 * W), int(0.63 * H)
    cv2.rectangle(frame, (x0, y0), (x1, y1), (0, 255, 0), 2)
    out, _ = pet_day.composite(bg, [(frame, box)])
    green = (out[..., 1].astype(int) - out[..., 2].astype(int)) > 60
    assert not green.any()


def test_lighting_change_over_the_whole_region_is_not_a_copy():
    bg = gray(100)
    box = (0.3, 0.3, 0.2, 0.3)
    brighter = gray(160)  # the sun came in: everything differs by 60
    _, kept = pet_day.composite(bg, [(brighter, box)])
    assert kept == []


def test_copy_is_cut_against_its_own_reference_but_pasted_on_the_base():
    base = gray(100)
    box = (0.3, 0.3, 0.2, 0.3)
    reference = gray(160)  # the room at the copy's time of day
    frame = with_block(reference, (0.35, 0.35, 0.1, 0.2), (0, 0, 0))
    out, kept = pet_day.composite(base, [(frame, box, reference)])
    assert kept == [0]
    assert (out[int(0.45 * H), int(0.4 * W)] == 0).all()  # Rex
    assert (out[int(0.32 * H), int(0.32 * W)] == 100).all()  # the rest stays the base


def test_camera_clock_area_is_never_pasted():
    bg = gray(100)
    box = (0.7, 0.8, 0.3, 0.2)  # a box in the bottom right corner
    frame = with_block(bg, (0.72, 0.82, 0.26, 0.18), (255, 255, 255))
    out, _ = pet_day.composite(bg, [(frame, box)])
    for x, y, w, h in pet_day.OVERLAY_ZONES:
        zone = out[int(y * H) + 1:int((y + h) * H) - 1, int(x * W) + 1:int((x + w) * W) - 1]
        assert (zone == 100).all()
    assert (out[int(0.85 * H), int(0.75 * W)] == 255).all()  # outside the zone it is pasted


def test_copy_fades_out_at_the_edge_of_its_region():
    """A change that runs to the edge of the region must not leave a hard
    straight edge there."""
    bg = gray(100)
    box = (0.4, 0.4, 0.2, 0.2)
    frame = with_block(bg, (0.35, 0.3, 0.3, 0.1), (160, 160, 160))  # a strip across the top
    frame = with_block(frame, (0.45, 0.45, 0.1, 0.1), (255, 255, 255))
    out, kept = pet_day.composite(bg, [(frame, box)])
    assert kept == [0]
    y0 = int((0.4 - pet_day.REGION_PAD * 0.2) * H)
    x0, x1 = int((0.4 - pet_day.REGION_PAD * 0.2) * W), int((0.6 + pet_day.REGION_PAD * 0.2) * W)
    assert (out[y0, x0:x1] == 100).all()  # the region's top row: nothing pasted


def test_clock_change_alone_is_not_a_copy():
    bg = gray(100)
    x, y, w, h = pet_day.OVERLAY_ZONES[0]
    frame = with_block(bg, (x + 0.01, y + 0.01, w - 0.02, h - 0.02), (255, 255, 255))
    _, kept = pet_day.composite(bg, [(frame, (0.75, 0.85, 0.2, 0.15))])
    assert kept == []


def test_green_tag_alone_is_not_a_copy():
    bg = gray(100)
    frame = bg.copy()
    cv2.rectangle(frame, (int(0.3 * W), int(0.3 * H)), (int(0.5 * W), int(0.6 * H)),
                  (0, 255, 0), 2)
    _, kept = pet_day.composite(bg, [(frame, (0.25, 0.25, 0.3, 0.4))])
    assert kept == []


# --- the whole day ------------------------------------------------------------------

DATE = "2027-01-15"
START = pet_day.local_midnight(DATE)
DAY_NOW = START + 20000
COUCH = (0.30, 0.50, 0.20, 0.15)  # centre (0.40, 0.575)
FLOOR = (0.70, 0.60, 0.15, 0.15)  # centre (0.775, 0.675)


TEXTURE = np.random.default_rng(0).integers(-12, 13, (H, W, 1))


def room():
    """The colour room with a fixed texture (a flat frame reads as smeared)."""
    return np.clip(colour().astype(int) + TEXTURE, 0, 255).astype(np.uint8)


def smear(frame, from_y=0.5):
    """What a broken recording looks like: one row repeated to the bottom."""
    f = frame.copy()
    y = int(from_y * f.shape[0])
    f[y:] = f[y]
    return f


class FakeFrigate:
    """A textured colour room; a white block wherever a dog or person event
    is at t; a smeared frame at the times in self.smeared."""

    def __init__(self, events, reviews):
        self.ev = events
        self.rv = reviews
        self.snaps = []
        self.smeared = set()

    def events(self, after=None, before=None, cameras=None, **kw):
        return [e for e in self.ev if after <= e["start_time"] < before
                and (not cameras or e["camera"] in cameras)]

    def reviews(self, after=None, before=None, **kw):
        return [r for r in self.rv if after <= r["start_time"] < before]

    def snapshot(self, camera, t, height):
        self.snaps.append((t, height))
        frame = room()
        for e in self.ev:
            if e["label"] in ("dog", "person") and e["start_time"] - 5 <= t <= e["end_time"]:
                frame = with_block(frame, pet_day._box_at(e, t), (255, 255, 255))
        if round(t, 2) in self.smeared:
            frame = smear(frame)
        size = (round(height * 16 / 9), height)
        big = cv2.resize(frame, size, interpolation=cv2.INTER_NEAREST)
        return cv2.imencode(".jpg", big)[1].tobytes()


def day_fixture():
    t1, t2, t3, t4 = START + 3000, START + 3600, START + 9000, START + 15000
    events = [
        event("d1", "dog", t1 - 10, t1 + 600, COUCH, snap=t1),
        event("d2", "dog", t2 - 10, t2 + 30, COUCH, snap=t2),
        event("d3", "dog", t3 - 10, t3 + 60, FLOOR, snap=t3),
        event("d4", "dog", t4 - 10, t4 + 30, COUCH, snap=t4),
        event("p4", "person", t4 - 20, t4 + 30, (0.45, 0.2, 0.1, 0.6), snap=t4),
        event("b1", "bark", t3 + 100, t3 + 161, None),
    ]
    reviews = [
        review("r1", t1 - 10, detections=["d1"], end=t1 + 600),
        review("r2", t2 - 10, detections=["d2"], end=t2 + 30),
        review("r3", t3 - 10, detections=["d3"], end=t3 + 60),
        review("r4", t4 - 20, objects=["dog", "person"], detections=["d4", "p4"], end=t4 + 30),
        review("r5", t3 + 100, objects=[], audio=["bark"], detections=["b1"], end=t3 + 161),
    ]
    sums = {"r1": summary("Rex naps on the couch", "Rex is curled up on the couch."),
            "r3": summary("Rex relaxes on the floor", "Rex lies on the rug.")}
    return events, reviews, sums


def maker_for(tmp_path, events, reviews, sums, clock=lambda: DAY_NOW):
    return pet_day.PetDay(FakeFrigate(events, reviews), str(tmp_path), PET,
                       clock=clock, summaries=lambda after: sums, width=W, source_height=360)


def test_make_day_writes_the_contract(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    result = maker.make(DATE)
    assert result == {"moments": 3, "dropped": 1, "places": 2, "rest": True}
    doc = json.loads((tmp_path / f"{DATE}.json").read_text())
    assert set(doc) == {"date", "updated", "rest", "main", "places", "ribbon", "moments", "barks"}
    assert doc["date"] == DATE and doc["updated"] == int(DAY_NOW)
    assert doc["rest"] == f"{DATE}/rest.jpg"
    # The couch (minutes 49..60 and 249..250 seen) is place 0, the main place.
    assert doc["main"] == {"place": 0, "minutes": doc["places"][0]["minutes"]}
    couch, floor = doc["places"]
    assert couch["id"] == 0 and couch["name"] == "couch" and couch["minutes"] == 14
    assert floor["id"] == 1 and floor["name"] == "floor" and floor["minutes"] == 3
    assert couch["x"] == pytest.approx(0.40) and couch["y"] == pytest.approx(0.575 / pet_day.CLOCK_BAND, abs=1e-4)
    t1, t2, t3 = START + 3000, START + 3600, START + 9000
    assert doc["moments"] == [
        {"t": t1, "place": 0, "image": f"{DATE}/{int(t1)}.jpg", "kind": "nap",
         "title": "Rex naps on the couch", "review": "r1"},
        {"t": t2, "place": 0, "image": f"{DATE}/{int(t2)}.jpg", "kind": None, "title": None,
         "review": "r2"},
        {"t": t3, "place": 1, "image": f"{DATE}/{int(t3)}.jpg", "kind": "floor",
         "title": "Rex relaxes on the floor", "review": "r3"}]
    assert doc["barks"] == [{"start": t3 + 130, "end": t3 + 131}]
    # The couch minutes from t1 to t2 are one run: the gap of under 30 min is filled.
    first = doc["ribbon"][0]
    assert first["place"] == 0 and first["start"] <= t1 and first["end"] >= t2
    assert all(set(r) == {"start", "end", "place"} for r in doc["ribbon"])
    assert maker.day(DATE) == doc


def test_moment_images_and_the_rest_picture(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    maker.make(DATE)
    img = cv2.imdecode(np.frombuffer(maker.image(DATE, f"{int(START + 3000)}.jpg"), np.uint8),
                       cv2.IMREAD_COLOR)
    assert img.shape == (pet_day.MOMENT_HEIGHT, pet_day.MOMENT_WIDTH, 3)
    assert (img[180, 320] > 230).all()  # Rex (the white block) in the middle
    rest = cv2.imdecode(np.frombuffer(maker.image(DATE, "rest.jpg"), np.uint8), cv2.IMREAD_COLOR)
    assert rest.shape == (round(H * pet_day.CLOCK_BAND), W, 3)
    cx, cy = int(0.40 * W), int(0.575 * H)
    assert (rest[cy, cx] > 230).all()  # one Rex at the couch
    assert (rest[int(0.675 * H), int(0.775 * W)] < 230).any()  # not at the floor place
    # The dropped moment (a person beside him) has no image.
    assert maker.image(DATE, f"{int(START + 15000)}.jpg") is None


def test_moment_images_are_fetched_once(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    maker.make(DATE)
    full = [s for s in maker.frigate.snaps if s[1] == 360]
    maker.make(DATE)
    assert [s for s in maker.frigate.snaps if s[1] == 360] == full
    assert len(full) == 3


def test_a_moment_that_is_gone_loses_its_image(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    maker.make(DATE)
    maker.frigate.rv = [r for r in reviews if r["id"] != "r2"]
    maker.make(DATE)
    assert maker.image(DATE, f"{int(START + 3600)}.jpg") is None
    assert maker.image(DATE, f"{int(START + 3000)}.jpg") is not None


def test_no_dog_makes_an_empty_day(tmp_path):
    maker = maker_for(tmp_path, [], [], {})
    assert maker.make(DATE) == {"moments": 0, "dropped": 0, "places": 0, "rest": False}
    doc = maker.day(DATE)
    assert doc["rest"] is None and doc["main"] is None and doc["places"] == []
    assert doc["moments"] == [] and doc["ribbon"] == [] and doc["barks"] == []


def test_days_newest_first(tmp_path):
    maker = maker_for(tmp_path, [], [], {})
    for date in ["2026-10-14", "2026-10-16", "2026-10-15"]:
        (tmp_path / f"{date}.json").write_text(json.dumps({"date": date, "updated": 5}))
    (tmp_path / "notes.json").write_text("{}")
    assert maker.days() == [{"date": "2026-10-16", "updated": 5},
                            {"date": "2026-10-15", "updated": 5},
                            {"date": "2026-10-14", "updated": 5}]


@pytest.mark.parametrize("date, name", [
    ("2026-10-16", "../state.json"), ("2026-10-16", "..\\rest.jpg"), ("..", "rest.jpg"),
    ("2026-10-16/..", "rest.jpg"), ("2026-10-16", "rest.png"), ("2026-10-16", "12.jpg"),
    ("2026-10-16", "1792150123.jpg.bak"), ("2026-1-16", "rest.jpg"), ("2026-10-16", ""),
    (None, "rest.jpg")])
def test_image_rejects_other_names(tmp_path, date, name):
    maker = maker_for(tmp_path, [], [], {})
    (tmp_path / "2026-10-16").mkdir()
    (tmp_path / "2026-10-16" / "rest.jpg").write_bytes(b"\xff\xd8")
    assert maker.image(date, name) is None
    assert maker.image("2026-10-16", "rest.jpg") == b"\xff\xd8"


def test_state_of_another_version_makes_the_finals_again(tmp_path):
    (tmp_path / "state.json").write_text(json.dumps({"final": ["2026-10-15"]}))
    maker = maker_for(tmp_path, [], [], {})
    assert maker.finals == set()  # the old final is made again with the new code
    maker.make(DATE)
    maker_for(tmp_path, [], [], {})  # a restart keeps the new files
    assert (tmp_path / f"{DATE}.json").exists()


# --- the schedule -------------------------------------------------------------------

def test_schedule_hourly_today_and_yesterday_at_00_10(tmp_path):
    made = []
    clock = {"t": time.mktime((2027, 1, 15, 9, 30, 0, 0, 0, -1))}

    def maker_at():
        m = pet_day.PetDay(FakeFrigate([], []), str(tmp_path), pet.Pet("Rex", "c"), clock=lambda: clock["t"])
        m.make = lambda date: made.append(date)
        return m

    maker = maker_at()
    maker.step()
    maker.step()
    # First start: the final data of the day before (once), then today.
    assert made == ["2027-01-14", "2027-01-15"]
    clock["t"] += 3600
    maker.step()
    assert made[2:] == ["2027-01-15"]  # once an hour
    clock["t"] = time.mktime((2027, 1, 16, 0, 5, 0, 0, 0, -1))
    maker.step()
    assert made[3:] == ["2027-01-16"]  # not yet the final of the 15th
    clock["t"] = time.mktime((2027, 1, 16, 0, 10, 0, 0, 0, -1))
    maker.step()
    assert made[4:] == ["2027-01-15"]  # the final data of the day before
    maker.step()
    assert made[5:] == []
    clock["t"] = time.mktime((2027, 1, 16, 0, 20, 0, 0, 0, -1))
    maker_at().step()  # a restart: the final of the 15th is not made again
    assert made[5:] == ["2027-01-16"]


def test_cluster_merges_places_whose_centres_drift_together():
    # Greedy alone makes two places here: (0.30) and (0.45) start apart, then
    # the points between pull their means under the radius of each other.
    labels, centres = pet_day.cluster([(0.30, 0.5), (0.45, 0.5), (0.36, 0.5), (0.39, 0.5)])
    assert len(centres) == 1 and labels == [0, 0, 0, 0]


def test_rest_falls_back_to_a_people_free_frame_without_quiet_frames(tmp_path):
    # Rex is tracked all day, so there is no quiet frame to cut him against.
    t1 = START + 3000
    events = [event("d1", "dog", START + 10, DAY_NOW, COUCH, snap=t1)]
    reviews = [review("r1", t1 - 10, detections=["d1"], end=t1 + 60)]
    maker = maker_for(tmp_path, events, reviews, {})
    assert maker.make(DATE)["rest"] is True
    rest = cv2.imdecode(np.frombuffer(maker.image(DATE, "rest.jpg"), np.uint8), cv2.IMREAD_COLOR)
    assert rest.shape == (round(H * pet_day.CLOCK_BAND), W, 3)
    assert (rest[int(0.575 * H), int(0.40 * W)] > 230).all()


def test_rest_never_falls_back_to_a_frame_with_a_person(tmp_path):
    t1 = START + 3000
    events = [event("d1", "dog", START + 10, DAY_NOW, COUCH, snap=t1),
              event("p1", "person", t1 - 100, t1 + 100, (0.0, 0.0, 0.1, 0.3), snap=t1)]
    reviews = [review("r1", t1 - 10, detections=["d1"], end=t1 + 60)]
    maker = maker_for(tmp_path, events, reviews, {})
    assert maker.make(DATE)["rest"] is False


# --- broken recordings (stripes) ------------------------------------------------------

def test_smeared_frame_is_found():
    big = cv2.resize(room(), (1280, 720), interpolation=cv2.INTER_NEAREST)
    assert not pet_day.is_smeared(big)
    assert pet_day.is_smeared(smear(big, 0.5))
    assert pet_day.is_smeared(smear(big, 0.75))
    assert not pet_day.is_smeared(smear(big, 0.92))  # under the clock band only


def test_dark_noisy_floor_is_not_smeared():
    dark = np.random.default_rng(1).integers(10, 16, (720, 1280, 3)).astype(np.uint8)
    assert not pet_day.is_smeared(dark)


def test_smeared_moment_frame_is_replaced_by_a_clean_one_nearby(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    t1 = START + 3000
    maker.frigate.smeared = {round(t1 - 1.75, 2), round(t1 - 1.25, 2)}
    assert maker.make(DATE)["moments"] == 3
    full = [t for t, h in maker.frigate.snaps if h == 360 and abs(t - t1) < 10]
    assert full == [round(t1 - 1.75, 3), round(t1 - 1.25, 3), round(t1 - 2.25, 3)]
    img = cv2.imdecode(np.frombuffer(maker.image(DATE, f"{int(t1)}.jpg"), np.uint8),
                       cv2.IMREAD_COLOR)
    assert not pet_day.is_smeared(cv2.resize(img, (1280, 720)))


def test_moment_with_no_clean_frame_is_dropped(tmp_path):
    events, reviews, sums = day_fixture()
    maker = maker_for(tmp_path, events, reviews, sums)
    t1 = START + 3000
    maker.frigate.smeared = {round(t1 - lag, 2) for lag in pet_day.CLEAN_LAGS}
    assert maker.make(DATE)["moments"] == 2
    assert maker.image(DATE, f"{int(t1)}.jpg") is None


def test_a_person_seen_minutes_before_or_after_still_drops_the_moment():
    """Frigate sees a person lying on the couch only in flickers (a measured
    gap of 166 s), so "at that time" reaches PERSON_SLACK_S."""
    rex = {"t": 10_000, "box": (0.4, 0.5, 0.2, 0.1), "review": "r1"}
    before = event("p1", "person", 9_800, 9_945, (0.35, 0.4, 0.3, 0.2))
    after = event("p2", "person", 10_111, 10_115, (0.35, 0.4, 0.3, 0.2))
    long_ago = event("p3", "person", 9_000, 10_000 - pet_day.PERSON_SLACK_S - 1, (0.35, 0.4, 0.3, 0.2))
    assert pet_day.keep_without_people([rex], [before]) == []
    assert pet_day.keep_without_people([rex], [after]) == []
    assert pet_day.keep_without_people([rex], [long_ago]) == [rex]

"""Tests for the pure alert rules. Run: python -m pytest -q helper"""

import json

import pet
from alerts import AUDIO_PRE_S, AUDIO_TAIL_S, camera_name, decide, place, review_url

NOW = 1_800_000_000.0
INDOOR = ["living_room_cam"]
CAM = "living_room_cam"
PET = pet.Pet("Rex", CAM)


def ev(id, label, start, end, cam=CAM):
    return {"id": id, "label": label, "camera": cam, "start_time": start, "end_time": end}


def bark(seconds, end_ago=0, cam=CAM, id="b1", label="bark"):
    """A Frigate sound event for `seconds` of barking that stopped end_ago s
    ago. Frigate starts the event AUDIO_PRE_S before the first sound and ends
    it AUDIO_TAIL_S after the last one (record.event_pre_capture and
    audio.max_not_heard, frigate/camera/activity_manager.py)."""
    last = NOW - end_ago
    return ev(id, label, last - seconds - AUDIO_PRE_S, last + AUDIO_TAIL_S, cam)


def run(events, state=None, now=NOW):
    return decide(events, now, state or {}, INDOOR, PET)


# --- bark -------------------------------------------------------------------

def test_119_s_of_bark_makes_no_push():
    pushes, _ = run([bark(119)])
    assert pushes == []


def test_121_s_of_bark_makes_one_push():
    pushes, _ = run([bark(121, end_ago=AUDIO_TAIL_S)])
    assert len(pushes) == 1
    p = pushes[0]
    assert p["kind"] == "bark" and p["camera"] == CAM and p["event_id"] == "b1"
    assert "Rex" in p["title"] and " he " in f" {p['body'].lower()} "
    assert "in the living room" in p["body"]


def test_exactly_120_s_is_enough():
    assert len(run([bark(120, end_ago=AUDIO_TAIL_S)])[0]) == 1


def test_two_single_barks_are_not_two_minutes_of_barking():
    # each single bark is a 61 s Frigate event
    events = [bark(1, end_ago=400, id="a"), bark(1, end_ago=60, id="b")]
    assert run(events)[0] == []
    three = events + [bark(1, end_ago=200, id="c")]
    assert run(three)[0] == []


def test_bark_and_howl_add_up_and_overlaps_count_once():
    events = [bark(70, end_ago=250, id="b1"), bark(60, end_ago=AUDIO_TAIL_S, id="h1", label="howl")]
    assert len(run(events)[0]) == 1  # 70 + 60 = 130 s
    overlapping = [bark(100, end_ago=AUDIO_TAIL_S, id="b1"), bark(100, end_ago=AUDIO_TAIL_S, id="h1", label="howl")]
    assert run(overlapping)[0] == []  # the same 100 s, heard as two labels


def test_only_the_last_10_min_count():
    # 200 s of bark, but it ended 9 min ago: only 60 s fall inside the window.
    assert run([bark(200, end_ago=540)])[0] == []


def test_bark_still_in_progress_counts_up_to_now():
    assert len(run([ev("b1", "bark", NOW - 130 - AUDIO_PRE_S, None)])[0]) == 1
    assert run([ev("b1", "bark", NOW - 110 - AUDIO_PRE_S, None)])[0] == []


def test_bark_outdoors_is_not_the_pet():
    # an outdoor camera hears other dogs; only indoor cameras count
    assert run([bark(300, end_ago=AUDIO_TAIL_S, cam="front_porch_cam")])[0] == []


def test_bark_on_two_cameras_does_not_add_up():
    events = [bark(70, id="a", cam="c1"), bark(70, id="b", cam="c2")]
    assert decide(events, NOW, {}, [])[0] == []


def test_person_19_min_ago_blocks_bark():
    person = ev("p1", "person", NOW - 1500, NOW - 19 * 60)
    assert run([bark(130), person])[0] == []


def test_person_21_min_ago_does_not_block():
    person = ev("p1", "person", NOW - 1500, NOW - 21 * 60)
    assert len(run([bark(130), person])[0]) == 1


def test_person_seen_10_min_ago_blocks_even_when_the_event_is_out_of_the_list():
    # the loop reads events started in the last hour,
    # so a long visit that ended 10 min ago is missing from the list
    person = ev("p1", "person", NOW - 5400, NOW - 600)
    _, state = run([person], now=NOW - 590)
    assert run([bark(130, end_ago=AUDIO_TAIL_S)], state)[0] == []


def test_person_still_in_view_blocks_even_if_seen_long_ago():
    person = ev("p1", "person", NOW - 4 * 3600, None)
    assert run([bark(130), person])[0] == []


def test_person_outdoors_does_not_block():
    person = ev("p1", "person", NOW - 60, None, cam="front_porch_cam")
    assert len(run([bark(130), person])[0]) == 1


def test_bark_cooldown_30_min_per_camera():
    _, state = run([bark(130, end_ago=AUDIO_TAIL_S)])
    assert run([bark(130, end_ago=AUDIO_TAIL_S, id="b2")], state, now=NOW + 29 * 60)[0] == []
    later = NOW + 31 * 60
    fresh = ev("b3", "bark", later - 130 - AUDIO_PRE_S, None)  # still barking
    assert len(decide([fresh], later, state, INDOOR)[0]) == 1
    # Another indoor camera is not held by this camera's cooldown.
    other = decide([bark(130, end_ago=AUDIO_TAIL_S, id="c", cam="kitchen_cam")], NOW + 60, state,
                   INDOOR + ["kitchen_cam"])[0]
    assert len(other) == 1


# --- smoke and glass ----------------------------------------------------------

def test_smoke_pushes_at_once_even_with_a_person_present():
    person = ev("p1", "person", NOW - 60, None)
    pushes, _ = run([ev("s1", "smoke_detector", NOW - 2, None), person])
    assert [p["kind"] for p in pushes] == ["smoke"]
    assert "Rex" in pushes[0]["body"] and pushes[0]["event_id"] == "s1"


def test_with_no_pet_the_alerts_use_plain_words():
    pushes, _ = decide([bark(121, end_ago=AUDIO_TAIL_S), ev("s1", "smoke_detector", NOW - 2, None)],
                       NOW, {}, INDOOR)
    by_kind = {p["kind"]: p for p in pushes}
    assert by_kind["bark"]["title"] == "A dog is barking"
    assert by_kind["bark"]["body"].startswith("A dog has barked")
    assert by_kind["smoke"]["body"] == "A smoke alarm is sounding in the living room."


def test_a_cat_pet_does_not_bark():
    miso = pet.Pet("Miso", CAM, "cat", "female")
    (p,), _ = decide([bark(121, end_ago=AUDIO_TAIL_S)], NOW, {}, INDOOR, miso)
    assert p["title"] == "A dog is barking"


def test_fire_alarm_is_smoke_and_shatter_is_glass():
    pushes, _ = run([ev("f1", "fire_alarm", NOW - 2, None),
                     ev("g1", "shatter", NOW - 2, None, cam="kitchen_cam")])
    assert sorted(p["kind"] for p in pushes) == ["glass", "smoke"]


def test_glass_and_breaking_labels_are_not_used():
    assert run([ev("x", "glass", NOW - 2, None), ev("y", "breaking", NOW - 2, None)])[0] == []


def test_each_event_pushes_once():
    _, state = run([ev("s1", "smoke_detector", NOW - 2, None)])
    later = NOW + 600  # past the cooldown, the same event again
    assert decide([ev("s1", "smoke_detector", NOW - 2, None)], later, state, INDOOR)[0] == []


def test_smoke_cooldown_5_min_per_camera():
    _, state = run([ev("s1", "smoke_detector", NOW - 2, NOW)])
    t = NOW + 4 * 60
    assert decide([ev("s2", "smoke_detector", t - 2, None)], t, state, INDOOR)[0] == []
    t = NOW + 6 * 60
    assert len(decide([ev("s3", "smoke_detector", t - 2, None)], t, state, INDOOR)[0]) == 1


def test_smoke_cooldown_does_not_hold_glass():
    _, state = run([ev("s1", "smoke_detector", NOW - 2, None)])
    pushes = decide([ev("g1", "shatter", NOW + 58, None)], NOW + 60, state, INDOOR)[0]
    assert [p["kind"] for p in pushes] == ["glass"]


def test_old_sound_does_not_push_on_first_start():
    """An empty state (first start) must not push a smoke alarm from an hour ago."""
    assert run([ev("s1", "smoke_detector", NOW - 3600, NOW - 3500)])[0] == []


# --- state ----------------------------------------------------------------------

def test_state_is_json_and_input_not_mutated():
    state = {}
    _, new = decide([ev("s1", "smoke_detector", NOW - 2, None), bark(130)], NOW, state, INDOOR)
    assert state == {}
    assert json.loads(json.dumps(new)) == new


def test_done_ids_are_pruned():
    _, state = run([ev("s1", "smoke_detector", NOW - 2, None)])
    _, state = decide([], NOW + 3 * 3600, state, INDOOR)
    assert "s1" not in json.dumps(state)


# --- words and links ------------------------------------------------------------

def test_smoke_cooldown_is_per_camera():
    a = ev("s1", "smoke_detector", NOW - 10, None, cam="living_room_cam")
    b = ev("s2", "smoke_detector", NOW - 5, None, cam="kitchen_cam")
    assert len(run([a, b])[0]) == 2


def test_place():
    assert place("living_room_cam") == "in the living room"
    assert place("front_porch_cam") == "at the front porch"


def test_camera_name():
    assert camera_name("living_room_cam") == "Living room"
    assert camera_name("front_porch_cam") == "Front porch"
    assert camera_name("garage") == "Garage"


def test_review_url_by_detection_then_by_time():
    reviews = [
        {"id": "r2", "camera": CAM, "start_time": NOW - 100, "end_time": None,
         "data": {"detections": ["x"]}},
        {"id": "r1", "camera": CAM, "start_time": NOW - 500, "end_time": NOW - 300,
         "data": {"detections": ["b1"]}},
    ]
    assert review_url(reviews, CAM, "b1", NOW - 50) == "/#review=r1"
    assert review_url(reviews, CAM, "zz", NOW - 50) == "/#review=r2"
    assert review_url(reviews, "other", "zz", NOW - 50) == "/"

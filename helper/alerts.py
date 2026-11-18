"""Alert rules: which Frigate events become a push. Pure functions only.

Rules:
- Bark: at least BARK_MIN_S of bark or howl sound on one indoor camera inside
  the last BARK_WINDOW_S, and no person on any indoor camera in the last
  PERSON_QUIET_S (a person at home hears the dog, so the push is for an empty
  home). Then a BARK_COOLDOWN_S cooldown per camera. The indoor cameras are
  the INDOOR_CAMERAS setting; with none, no bark alert is sent.
- Smoke (smoke_detector, fire_alarm) and glass (shatter): a push at once,
  every time, person or not, with a SOUND_COOLDOWN_S cooldown per camera and
  kind. The labels glass and breaking are not used: they also mean dishes.
- Each event pushes at most once.
- The words name the pet of the settings (pet.py) when there is one.
- The words name each camera by its title: the user's name (names.py), else
  the name derived from the Frigate key.

What this does not do:
- Overlapping bark and howl events count once (their union), but nothing
  checks that Frigate's sound events are accurate; a dog on the TV counts.
- A smoke or glass event that started more than FRESH_S ago never pushes, so
  a first start (empty state) does not replay old alarms. A helper that is
  down for longer than FRESH_S misses an alarm that started meanwhile.
- A person event counts until it ends, however long ago it started, so the
  caller must pass events still in progress (end_time null) as well.
"""

import copy
import re

import names

BARK_LABELS = {"bark", "howl"}
SOUND_KINDS = {"smoke_detector": "smoke", "fire_alarm": "smoke", "shatter": "glass"}
BARK_MIN_S = 120
BARK_WINDOW_S = 600
PERSON_QUIET_S = 1200
BARK_COOLDOWN_S = 1800
SOUND_COOLDOWN_S = 300
FRESH_S = 300
# Frigate pads a sound event: it starts record.event_pre_capture (30 s, the
# larger of alerts and detections pre_capture in frigate/config/config.yml)
# before the first sound, and ends after audio.max_not_heard (30 s) of quiet
# (frigate/camera/activity_manager.py, track/object_processing.py). Without
# taking these off, one bark counted as a minute.
AUDIO_PRE_S = 30
AUDIO_TAIL_S = 30
DONE_KEEP_S = 7200


camera_name = names.camera_name


def place(camera, title_of=camera_name):
    """living_room_cam -> "in the living room"; front_porch_cam -> "at the front porch".

    title_of gives the title of a camera (names.Names.title). The title
    takes the place phrase of names.py, the same rule as in the app.
    """
    return names.place_phrase(title_of(camera) or camera_name(camera))


def _heard(event, now):
    """The stretch a sound was actually heard: the event less Frigate's padding.
    A single bark is about 1 s."""
    start = event["start_time"] + AUDIO_PRE_S
    end = now if event.get("end_time") is None else event["end_time"] - AUDIO_TAIL_S
    end = min(end, now)
    return start, max(end, start + 1)


def _span(event, now):
    end = event.get("end_time")
    return event["start_time"], now if end is None else min(end, now)


def _union_seconds(spans):
    total, cur_start, cur_end = 0.0, None, None
    for start, end in sorted(spans):
        if end <= start:
            continue
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += cur_end - cur_start
            cur_start, cur_end = start, end
        else:
            cur_end = max(cur_end, end)
    if cur_end is not None:
        total += cur_end - cur_start
    return total


def _last_person(events, now, indoor, before):
    """The latest time a person was seen on an indoor camera: from these events,
    or `before` (kept in the state, because the loop reads only recent events
    and a long visit that ended a few minutes ago can be missing)."""
    last = before
    for e in events:
        if e["label"] == "person" and e["camera"] in indoor:
            start, end = _span(e, now)
            if start <= now:
                last = end if last is None else max(last, end)
    return last


def _cooled(state, key, now, cooldown):
    last = state["cooldown"].get(key)
    return last is None or now - last >= cooldown


def decide(events, now, state, indoor_cameras, pet=None, title_of=camera_name):
    """Return (pushes, new_state). Does not change its inputs.

    pet: the pet.Pet of the settings, or None. A dog pet gives its name to the
    bark alert, and any pet to the smoke and glass alerts.

    title_of: camera -> its title (names.Names.title). The default is the
    name derived from the key.

    events: Frigate events with id, label, camera, start_time, end_time.
    state: the dict this function returned last time ({} at first start).
    A push is {"kind", "camera", "event_id", "time", "title", "body"}.
    """
    state = copy.deepcopy(state) if state else {}
    state.setdefault("cooldown", {})
    state.setdefault("done", {})
    state["done"] = {k: t for k, t in state["done"].items() if now - t < DONE_KEEP_S}
    pushes = []

    # Smoke and glass: each fresh event once, cooldown per camera and kind.
    for e in sorted(events, key=lambda e: e["start_time"]):
        kind = SOUND_KINDS.get(e["label"])
        if kind is None or e["id"] in state["done"] or e["start_time"] < now - FRESH_S:
            continue
        state["done"][e["id"]] = now
        key = f"{kind}:{e['camera']}"
        if not _cooled(state, key, now, SOUND_COOLDOWN_S):
            continue
        state["cooldown"][key] = now
        where = place(e["camera"], title_of)
        check = f" Check on {pet.name}." if pet else ""
        if kind == "smoke":
            title, body = "Smoke alarm", f"A smoke alarm is sounding {where}.{check}"
        else:
            title, body = "Glass breaking", f"Breaking glass was heard {where}.{check}"
        pushes.append({"kind": kind, "camera": e["camera"], "event_id": e["id"],
                       "time": e["start_time"], "title": title, "body": body})

    # Bark: time actually heard in the window, per indoor camera (an outdoor
    # camera hears other dogs), and only when nobody was seen inside lately.
    indoor = set(indoor_cameras)
    state["last_person"] = _last_person(events, now, indoor, state.get("last_person"))
    nobody_home = state["last_person"] is None or now - state["last_person"] > PERSON_QUIET_S
    if nobody_home:
        by_camera = {}
        for e in events:
            if e["label"] in BARK_LABELS and e["camera"] in indoor:
                by_camera.setdefault(e["camera"], []).append(e)
        for camera, barks in sorted(by_camera.items()):
            spans = []
            for e in barks:
                start, end = _heard(e, now)
                spans.append((max(start, now - BARK_WINDOW_S), end))
            seconds = _union_seconds(spans)
            key = f"bark:{camera}"
            if seconds < BARK_MIN_S or not _cooled(state, key, now, BARK_COOLDOWN_S):
                continue
            state["cooldown"][key] = now
            latest = max(barks, key=lambda e: e["start_time"])
            minutes = max(2, round(seconds / 60))
            if pet and pet.label == "dog":
                title, who = f"{pet.name} is barking", pet.he.capitalize()
            else:
                title, who = "A dog is barking", "A dog"
            pushes.append({
                "kind": "bark", "camera": camera, "event_id": latest["id"],
                "time": latest["start_time"], "title": title,
                "body": f"{who} has barked for about {minutes} of the last 10 min "
                        f"{place(camera, title_of)}. Nobody was seen inside."})
    return pushes, state


def review_url(reviews, camera, event_id, t):
    """The app link for a push: the review item that holds the event."""
    for r in reviews:
        if event_id in (r.get("data") or {}).get("detections", []):
            return f"/#review={r['id']}"
    for r in reviews:
        end = r.get("end_time")
        if r["camera"] == camera and r["start_time"] <= t and (end is None or t <= end):
            return f"/#review={r['id']}"
    return "/"

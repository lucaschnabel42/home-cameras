"""The pet day: the data behind the pet's story screen, one day per entry.

For each day this module writes <date>.json (without the story; app.py adds
it from story.py) and the folder <date>/ with one image per moment and
rest.jpg. It runs only when the settings name a pet (pet.py).

How it is made:
- Moments: one per review item on the pet camera with the pet's label in its
  objects. Its time is the snapshot frame time of a pet event of that item
  (Frigate's best frame, where data.box is exact) when that lies inside the
  item; else the path point inside the item nearest its middle, with the
  event box size.
- Each moment image is the recorded frame RECORDING_LAG_S before the moment,
  fetched at SOURCE_HEIGHT, cropped around the pet (crop_rect), with the
  camera's green motion box painted out (inpainting), and scaled to
  MOMENT_WIDTH.
- Broken recordings: some recorded frames are smeared (the decoder repeats
  one row down to the bottom, which shows as vertical stripes; about 1 in 9
  moments in a measured day). is_smeared finds them. The moment then takes
  the frame at the next of CLEAN_LAGS, nearest RECORDING_LAG_S first, and is
  dropped when none is clean. Smeared frames never enter the rest picture.
- The person rule: a moment whose crop meets a Frigate person box within
  PERSON_SLACK_S of its time is dropped. The crop is a wider test than the
  pet's box, because a person next to the pet would be in the picture. The
  slack covers Frigate's flickering detection of a person lying still.
- Places: moment centres (box centres, 0..1 of the frame) are clustered
  greedily in time order: a centre joins the nearest place whose mean is
  under PLACE_RADIUS away, else it starts a new place.
- Minutes seen per place: every minute inside a Frigate pet event (a tracked
  span) goes to the place nearest the pet's box centre at the path point
  nearest that minute, if under 2 * PLACE_RADIUS away. A gap of up to
  FILL_MIN minutes between two minutes at the same place is filled. The
  ribbon is the runs of these minutes. Place 0 has the most minutes (main).
- A place's name is the commonest of PLACE_WORDS in the summaries of its
  moments (a word in the title counts 2, in the summary 1); else null.
- Barks: bark and howl events less Frigate's padding (alerts.AUDIO_PRE_S,
  alerts.AUDIO_TAIL_S), overlaps merged.
- The rest picture: the median of quiet frames (no event of any label near
  them) of one lighting, with ONE solid copy of the pet pasted from a moment
  at the main place (composite: what changed inside its box against quiet
  frames near that time). When no moment can be pasted (too few quiet
  frames, or the light differs too much), it is the whole frame of a moment
  at the main place with no person box anywhere at that time. The camera's
  clock band (below CLOCK_BAND) is cut off.
- Places x and y are 0..1 of the rest picture, that is of the frame above
  CLOCK_BAND, so a dot lands on the picture the app shows.

RECORDING_LAG_S is a measured value: for 14 events, the recording frame that
best matched Frigate's own event snapshot (detect stream) lay 0.5 to 2.5 s
before the snapshot's frame time, median 1.75 s.

What this does not do:
- It does not find the pet in the frame; it trusts Frigate's box and the lag.
  A person that Frigate labels as the pet becomes a moment.
- A person that Frigate does not detect is not caught by the person rule.
- The pasted copy in the rest picture is whatever changed inside the pet's
  box, so a moved cushion in that box is pasted too.
- Minutes are whole minutes inside tracked spans; they are not a measure of
  time spent, only of time seen (the app labels them "minutes seen").
- The clock band, the logo zones, and the green box are those of a Wyze
  camera. On another camera the cut removes the bottom 7 % of the rest
  picture, and pure green pixels are painted over.
- Day folders are never pruned; about 5 MB a day.
"""

import datetime
import functools
import json
import logging
import math
import os
import re
import shutil
import time

import cv2
import numpy as np

import alerts
import jsonstore

VERSION = 2
RECORDING_LAG_S = 1.75
# Lags to try, in order, when the frame at RECORDING_LAG_S is smeared. In a
# measured day a clean frame lay within these for 11 of 12 smeared moments.
CLEAN_LAGS = [1.75, 1.25, 2.25, 0.75, 2.75, 0.25, 3.25, 3.75, 4.75]
# A frame is smeared when at least SMEAR_FRAC of its columns end (above the
# clock band) in a run of rows that change by at most SMEAR_TOL, at least
# SMEAR_RUN of the height long. Measured on full frames: every
# striped frame 0.42 or more, every clean one 0.05 or less.
SMEAR_TOL = 1
SMEAR_RUN = 0.12
SMEAR_FRAC = 0.2
BG_FRAMES = 15
BG_STEP_S = 1800
BG_MARGIN_S = 60
NIGHT_SATURATION = 12
DIFF_LEVEL = 30
REGION_PAD = 0.25
MIN_MASK_FRAC = 0.03
# A copy whose change covers more than this share of its padded region is a
# change of light (sun, a lamp), not the pet: a pet fills well under half of it.
MAX_REGION_FRAC = 0.6
# The pet is cut against the median of this many quiet frames of its own
# lighting nearest to it in time, because daylight moves through the day.
LOCAL_FRAMES = 5
# Width in px of the band around the camera's green motion box that is
# filled in. JPEG smears the line by a few pixels.
TAG_BAND = 7
# The camera's own burned-in text (x, y, w, h): the clock bottom right and
# the WYZE logo bottom left. Both lie below CLOCK_BAND, which is cut off.
OVERLAY_ZONES = [(0.77, 0.93, 0.23, 0.07), (0.0, 0.93, 0.12, 0.07)]
CLOCK_BAND = 0.93
ALPHA_OLDEST = 0.35
WIDTH = 1280  # frames for the rest picture
SOURCE_HEIGHT = 1440  # frames for moment images (the camera's full size)
MOMENT_WIDTH, MOMENT_HEIGHT = 640, 360
CROP_MARGIN = 0.5  # of the box size, added on each side
MIN_CROP = 0.25  # of the frame width
PLACE_RADIUS = 0.12
FILL_MIN = 30
# Frigate sees a person lying on the couch only in flickers (measured gaps of
# up to 166 s, when a person on the couch reached a moment image),
# so a person box counts from this long before its event to this long after.
PERSON_SLACK_S = 180
EVENTS_BEFORE_S = 12 * 3600  # a tracked span that started before midnight
REST_TRIES = 6
PLACE_WORDS = ["couch", "floor", "rug", "kitchen", "window", "door", "table", "bed"]
PLACE_SYNONYMS = {"sofa": "couch", "sectional": "couch"}
FINAL_AT = (0, 10)  # local time to make the final data of the day before

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IMAGE = re.compile(r"^(rest|\d{9,11})\.jpg$")
DAY_JSON = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")

log = logging.getLogger("cam-helper.pet")


# --- kinds of moment (shared with story.py) --------------------------------------

KINDS = ("nap", "rest", "floor", "walk", "play", "with-person", "bark", "other")
RARE_KINDS = ("play", "with-person", "bark")

_BARK = re.compile(r"\b(bark\w*|howl\w*)\b", re.I)
_PLAY = re.compile(r"\b(play|plays|playing|played|playful\w*|chas\w*|fetch\w*|tug\w*|ball|toy|toys)\b",
                   re.I)
_PERSON = re.compile(r"\b(person|people|someone|man|woman)\b", re.I)
_TOGETHER_WORDS = (r"pet|pets|petting|petted|cuddl\w*|hug\w*|strok\w*|scratch\w*|rubs?|rubbing|"
                   r"hold\w*|feed\w*|throw\w*|threw|toss\w*|follow\w*|beside|next to|lap|greet\w*")
_NAP = re.compile(r"\b(nap\w*|sleep\w*|asleep|slept|curled|doz\w*|snooz\w*)\b", re.I)
_WALK = re.compile(r"\b(walk\w*|mov\w*|explor\w*|sniff\w*|trot\w*|run|runs|running|ran|"
                   r"wander\w*|enter\w*|leav\w*|climb\w*|jump\w*|investigat\w*|stands|"
                   r"patrol\w*|shift\w*)\b", re.I)
_REST = re.compile(r"\b(rest\w*|relax\w*|lie|lies|lying|lay|lays|laying|loung\w*|sit|sits|"
                   r"sitting|settl\w*|remains)\b", re.I)
_FLOOR = re.compile(r"\b(floor|rug|carpet)\b", re.I)
_COUCH = re.compile(r"\b(couch|sofa|sectional)\b", re.I)


@functools.lru_cache(maxsize=8)
def _pet_words(pet):
    """(together, about, name) patterns for one pet.

    together: a person does something with the pet ("with <name>", "with
    him"). about: a sentence about the pet (its name, its label, or its
    pronouns). name: the pet's name as a word.
    """
    name = re.escape(pet.name)
    together = re.compile(rf"\b({_TOGETHER_WORDS}|with {name}|with {pet.him})\b", re.I)
    about = re.compile(rf"\b({name}|{pet.label}|{pet.he}|{pet.his}|{pet.him})\b", re.I)
    return together, about, re.compile(rf"\b{name}\b", re.I)


def _calm_kind(text):
    """nap, walk, rest or floor from one text; None if it names none."""
    if _NAP.search(text):
        return "nap"
    if _WALK.search(text):
        return "walk"
    if _REST.search(text):
        if _FLOOR.search(text) and not _COUCH.search(text):
            return "floor"
        return "rest"
    return None


def moment_kind(review, summary, pet):
    """The kind of one review item from its summary (title and text).

    bark: the camera heard a bark or howl, or the summary says so. play and
    with-person (a person doing something with the pet in one sentence) come
    from the whole summary; nap, walk, rest, floor from the title, else from
    the sentences about the pet. None without a summary."""
    audio = set(((review.get("data") or {}).get("audio")) or [])
    if audio & pet.sounds:
        return "bark"
    if not summary:
        return None
    title, text = summary.get("title", ""), summary.get("summary", "")
    whole = title + ". " + text
    if _BARK.search(whole):
        return "bark"
    if _PLAY.search(whole):
        return "play"
    together, about_pet, name = _pet_words(pet)
    for sentence in re.split(r"(?<=[.!?])\s+", whole):
        if _PERSON.search(sentence) and together.search(sentence):
            return "with-person"
    if name.search(title):
        kind = _calm_kind(title)
        if kind:
            return kind
    about = " ".join(s for s in re.split(r"(?<=[.!?])\s+", text) if about_pet.search(s))
    return _calm_kind(about) or _calm_kind(title) or "other"


def place_name(summaries):
    """The commonest PLACE_WORDS word in summaries (title x2, text x1); None."""
    score = {w: 0 for w in PLACE_WORDS}
    for s in summaries:
        for key, weight in (("title", 2), ("summary", 1)):
            for word in re.findall(r"[a-z]+", (s.get(key) or "").lower()):
                word = PLACE_SYNONYMS.get(word, word)
                if word in score:
                    score[word] += weight
    best = max(PLACE_WORDS, key=lambda w: (score[w], -PLACE_WORDS.index(w)))
    return best if score[best] > 0 else None


# --- geometry ---------------------------------------------------------------------

def is_night(frame):
    """True for the camera's grey infrared picture."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    return bool(hsv[..., 1].mean() < NIGHT_SATURATION)


def _fit(x, y, w, h):
    w, h = min(w, 1.0), min(h, 1.0)
    return (min(max(x, 0.0), 1.0 - w), min(max(y, 0.0), 1.0 - h), w, h)


def _box_at(event, t):
    """The event's box (x, y, w, h) at time t: the path point nearest t
    (bottom centre) with the event box size; the event box without a path."""
    data = event.get("data") or {}
    box = data.get("box")
    if not box:
        return None
    _, _, w, h = box
    path = data.get("path_data") or []
    if not path:
        return _fit(*box)
    (px, py), _ = min(path, key=lambda p: abs(p[1] - t))
    return _fit(px - w / 2, py - h, w, h)


def centre(box):
    x, y, w, h = box
    return (x + w / 2, y + h / 2)


def meets(a, b):
    """True when boxes a and b, each (x0, y0, x1, y1), overlap with area > 0."""
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def crop_rect(box, frame_aspect=16 / 9):
    """(x0, y0, x1, y1), 0..1 of the frame: a MOMENT_WIDTH x MOMENT_HEIGHT
    shaped crop around box with CROP_MARGIN, at least MIN_CROP wide, inside
    the frame and above CLOCK_BAND."""
    x, y, w, h = box
    shape = (MOMENT_WIDTH / MOMENT_HEIGHT) / frame_aspect  # crop w / crop h, 0..1 units
    cw = max(MIN_CROP, w * (1 + 2 * CROP_MARGIN), h * (1 + 2 * CROP_MARGIN) * shape)
    ch = cw / shape
    if ch > CLOCK_BAND:
        ch = CLOCK_BAND
        cw = ch * shape
    cw = min(cw, 1.0)
    cx, cy = x + w / 2, y + h / 2
    x0 = min(max(cx - cw / 2, 0.0), 1.0 - cw)
    y0 = min(max(cy - ch / 2, 0.0), CLOCK_BAND - ch)
    return (x0, y0, x0 + cw, y0 + ch)


def person_boxes(events, t):
    """(x0, y0, x1, y1) of every person event within PERSON_SLACK_S of t (its
    box nearest t), 0..1 of the frame."""
    out = []
    for e in events:
        if e.get("label") != "person":
            continue
        end = e.get("end_time")
        if t < e["start_time"] - PERSON_SLACK_S or (end is not None and t > end + PERSON_SLACK_S):
            continue
        box = _box_at(e, min(max(t, e["start_time"]), end if end is not None else t))
        if box:
            x, y, w, h = box
            out.append((x, y, x + w, y + h))
    return out


# --- choosing moments -----------------------------------------------------------------

def pet_moments(reviews, events, camera, label, start, end):
    """[{t, box, review}] for review items on camera with label (the pet's
    Frigate label) whose start lies in [start, end), oldest first, one per
    item."""
    by_id = {e["id"]: e for e in events}
    out = []
    for r in reviews:
        data = r.get("data") or {}
        if r.get("camera") != camera or label not in (data.get("objects") or []):
            continue
        if not start <= r["start_time"] < end:
            continue
        r_end = r.get("end_time") or end
        pets = [by_id[d] for d in data.get("detections") or []
                if d in by_id and by_id[d].get("label") == label]
        if not pets:  # an event outside the fetched window: any pet span inside
            pets = [e for e in events if e.get("label") == label and e["camera"] == camera
                    and e["start_time"] <= r_end and (e.get("end_time") or end) >= r["start_time"]]
        moment = None
        for e in pets:
            d = e.get("data") or {}
            snap = d.get("snapshot_frame_time")
            if d.get("box") and snap and r["start_time"] <= snap <= r_end:
                moment = (snap, _fit(*d["box"]))
                break
        if moment is None:
            mid = (r["start_time"] + r_end) / 2
            points = [(abs(t - mid), t, e) for e in pets
                      for _, t in ((e.get("data") or {}).get("path_data") or [])
                      if r["start_time"] <= t <= r_end]
            if points:
                _, t, e = min(points, key=lambda p: p[0])
                moment = (t, _box_at(e, t))
        if moment is None or moment[1] is None:
            continue
        out.append({"t": round(moment[0], 3), "box": moment[1], "review": r["id"]})
    out.sort(key=lambda m: m["t"])
    seen, unique = set(), []
    for m in out:  # image names are whole seconds
        if int(m["t"]) not in seen:
            seen.add(int(m["t"]))
            unique.append(m)
    return unique


def keep_without_people(moments, events):
    """The moments whose crop meets no person box at their time."""
    return [m for m in moments
            if not any(meets(crop_rect(m["box"]), p) for p in person_boxes(events, m["t"]))]


# --- places, minutes, ribbon, barks ---------------------------------------------------

def cluster(points, radius=PLACE_RADIUS):
    """Greedy clustering in the given order, then the two places whose means
    are nearest are merged while they are under radius apart (means drift as
    points join, so greedy alone splits one couch into several places).
    Returns (labels, centres)."""
    members, labels = [], []
    for p in points:
        best, dist = None, None
        for k, group in enumerate(members):
            c = np.mean(group, axis=0)
            d = math.dist(c, p)
            if dist is None or d < dist:
                best, dist = k, d
        if best is not None and dist < radius:
            members[best].append(p)
            labels.append(best)
        else:
            members.append([p])
            labels.append(len(members) - 1)
    while len(members) > 1:
        means = [np.mean(g, axis=0) for g in members]
        d, a, b = min((math.dist(means[i], means[j]), i, j)
                      for i in range(len(members)) for j in range(i + 1, len(members)))
        if d >= radius:
            break
        members[a] += members.pop(b)
        labels = [a if k == b else k - 1 if k > b else k for k in labels]
    return labels, [tuple(float(v) for v in np.mean(g, axis=0)) for g in members]


def minutes_seen(events, label, centres, start, end, now, radius=2 * PLACE_RADIUS,
                 fill=FILL_MIN):
    """{minute index from start: place} for minutes inside spans of label
    (the pet), with gaps of up to `fill` minutes at the same place filled."""
    seen = {}
    if not centres:
        return seen
    last = int((end - start) // 60)
    for e in events:
        if e.get("label") != label or not (e.get("data") or {}).get("box"):
            continue
        e_end = e.get("end_time") or now
        m0 = max(0, int((e["start_time"] - start) // 60))
        m1 = min(last, int((min(e_end, end) - start) // 60))
        for m in range(m0, m1 + 1):
            t = start + m * 60 + 30
            c = centre(_box_at(e, t))
            k = min(range(len(centres)), key=lambda i: math.dist(centres[i], c))
            if math.dist(centres[k], c) < radius:
                seen[m] = k
    filled = dict(seen)
    ms = sorted(seen)
    for a, b in zip(ms, ms[1:]):
        if 1 < b - a <= fill and seen[a] == seen[b]:
            for m in range(a + 1, b):
                filled[m] = seen[a]
    return filled


def ribbon(minutes, start):
    """Runs of minutes at one place: [{start, end, place}] in unix seconds."""
    out = []
    for m in sorted(minutes):
        k = minutes[m]
        if out and out[-1]["place"] == k and out[-1]["end"] == start + m * 60:
            out[-1]["end"] += 60
        else:
            out.append({"start": start + m * 60, "end": start + (m + 1) * 60, "place": k})
    return out


def barks(events, camera, start, end, now):
    """Heard bark and howl spans on camera starting in [start, end), merged."""
    spans = []
    for e in events:
        if e.get("label") in alerts.BARK_LABELS and e.get("camera") == camera:
            a, b = alerts._heard(e, now)
            if start <= a < end:
                spans.append([a, b])
    spans.sort()
    out = []
    for a, b in spans:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [{"start": round(a, 1), "end": round(b, 1)} for a, b in out]


# --- pictures ---------------------------------------------------------------------------

def background_times(events, start, end, step=BG_STEP_S, margin=BG_MARGIN_S):
    """Times on a fixed grid in [start, end) with no event near them."""
    busy = [(e["start_time"] - margin, (e.get("end_time") or end) + margin) for e in events]
    times, t = [], start + step / 2
    while t < end:
        if not any(a <= t <= b for a, b in busy):
            times.append(t)
        t += step
    return times


def _even(items, n):
    if len(items) <= n:
        return list(items)
    return [items[i] for i in np.linspace(0, len(items) - 1, n).round().astype(int)]


def is_smeared(frame):
    """True when the bottom of the frame (above the clock band) is one row
    repeated down: a recording the decoder could not read."""
    above = frame[:int(frame.shape[0] * CLOCK_BAND)].astype(np.int16)
    frozen = np.abs(np.diff(above, axis=0)).max(axis=2) <= SMEAR_TOL
    upward = np.vstack([frozen[::-1], np.zeros((1, frozen.shape[1]), bool)])
    run = np.argmin(upward, axis=0)  # frozen rows that end at the bottom, per column
    return bool((run >= SMEAR_RUN * above.shape[0]).mean() >= SMEAR_FRAC)


def _tag_pixels(frame):
    """The camera's pure green motion box."""
    b, g, r = (frame[..., i].astype(np.int16) for i in range(3))
    return (g > 150) & (r < 120) & (b < 120) & (g - r > 80) & (g - b > 80)


def paint_out_tag(image):
    """image with the camera's green motion box filled from its neighbours."""
    tag = _tag_pixels(image)
    if not tag.any():
        return image
    band = cv2.dilate(tag.astype(np.uint8), np.ones((TAG_BAND, TAG_BAND), np.uint8))
    return cv2.inpaint(image, band, 3, cv2.INPAINT_TELEA)


def _overlay_mask(hgt, wid):
    mask = np.zeros((hgt, wid), bool)
    for x, y, w, h in OVERLAY_ZONES:
        mask[int(y * hgt):int(np.ceil((y + h) * hgt)), int(x * wid):int(np.ceil((x + w) * wid))] = True
    return mask


def base_picture(frames):
    """The median of frames (oldest first)."""
    return np.median(np.stack(frames), axis=0).astype(np.uint8)


def cut_clock_band(picture):
    return picture[:int(round(picture.shape[0] * CLOCK_BAND))]


def moment_image(frame, box):
    """The moment picture: a crop around box, green box painted out,
    MOMENT_WIDTH x MOMENT_HEIGHT."""
    hgt, wid = frame.shape[:2]
    x0, y0, x1, y1 = crop_rect(box, wid / hgt)
    part = frame[int(round(y0 * hgt)):int(y1 * hgt), int(round(x0 * wid)):int(round(x1 * wid))]
    part = paint_out_tag(np.ascontiguousarray(part))
    return cv2.resize(part, (MOMENT_WIDTH, MOMENT_HEIGHT), interpolation=cv2.INTER_AREA)


def _edge_fade(rows, cols, width, top, bottom, left, right):
    """1.0 inside, falling to 0 over width px at each side that is True."""
    def ramp(n, start, end):
        i = np.arange(n, dtype=np.float32)
        r = np.ones(n, np.float32)
        if start:
            r = np.minimum(r, i / width)
        if end:
            r = np.minimum(r, (n - 1 - i) / width)
        return np.clip(r, 0.0, 1.0)
    return np.minimum.outer(ramp(rows, top, bottom), ramp(cols, left, right))


def composite(background, copies):
    """Paste copies (oldest first) onto background.

    Each copy is (frame, (x, y, w, h)) or (frame, box, reference): the copy is
    the part of its box where frame differs from reference (default: the
    background). Returns (picture, indexes of the copies that were pasted).
    The rest picture uses one copy, which is pasted solid.
    """
    hgt, wid = background.shape[:2]
    k = max(3, (wid // 160) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    out = background.astype(np.float32)
    overlay = _overlay_mask(hgt, wid)
    kept = []
    n = len(copies)
    for i, item in enumerate(copies):
        frame, (x, y, w, h) = item[0], item[1]
        reference = item[2] if len(item) > 2 else background
        alpha = 1.0 if n == 1 else ALPHA_OLDEST + (1.0 - ALPHA_OLDEST) * i / (n - 1)
        x0 = int(max(0.0, x - REGION_PAD * w) * wid)
        y0 = int(max(0.0, y - REGION_PAD * h) * hgt)
        x1 = int(min(1.0, x + w + REGION_PAD * w) * wid)
        y1 = int(min(1.0, y + h + REGION_PAD * h) * hgt)
        if x1 <= x0 or y1 <= y0:
            continue
        part = paint_out_tag(np.ascontiguousarray(frame[y0:y1, x0:x1]))
        diff = np.abs(part.astype(np.int16) - reference[y0:y1, x0:x1].astype(np.int16))
        changed = diff.max(axis=2) > DIFF_LEVEL
        never = overlay[y0:y1, x0:x1]
        changed &= ~never
        box_area = max(1.0, w * wid * h * hgt)
        if changed.sum() / box_area < MIN_MASK_FRAC:
            continue
        if changed.mean() > MAX_REGION_FRAC:
            continue
        mask = cv2.dilate(changed.astype(np.uint8) * 255, kernel, iterations=2)
        mask = cv2.GaussianBlur(mask, (k, k), 0)
        mask[never] = 0
        # Fade to nothing at the region's sides inside the frame, so a change
        # that reaches them leaves no straight edge.
        fade = _edge_fade(y1 - y0, x1 - x0, 2 * k, y0 > 0, y1 < hgt, x0 > 0, x1 < wid)
        m = (mask.astype(np.float32) / 255.0 * fade * alpha)[..., None]
        out[y0:y1, x0:x1] = out[y0:y1, x0:x1] * (1.0 - m) + part.astype(np.float32) * m
        kept.append(i)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8), kept


# --- files --------------------------------------------------------------------------------

def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _jpeg(picture, quality=85):
    ok, jpg = cv2.imencode(".jpg", picture, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("JPEG encode failed")
    return jpg.tobytes()


def local_midnight(date):
    d = datetime.date.fromisoformat(date)
    return time.mktime((d.year, d.month, d.day, 0, 0, 0, 0, 0, -1))


def day_bounds(date):
    nxt = (datetime.date.fromisoformat(date) + datetime.timedelta(days=1)).isoformat()
    return local_midnight(date), local_midnight(nxt)


def _decode(data):
    if not data:
        return None
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


class PetDay:
    """Makes and serves the day data. pet is a pet.Pet. summaries(after) is
    the summarizer's {review id: {"title", "summary"}} for items that start at
    or after `after`."""

    def __init__(self, frigate, out_dir, pet, clock, summaries=None, width=WIDTH,
                 source_height=SOURCE_HEIGHT):
        self.frigate = frigate
        self.dir = out_dir
        self.pet = pet
        self.camera = pet.camera
        self.clock = clock
        self.summaries = summaries or (lambda after: {})
        self.width = width
        self.source_height = source_height
        self.state_path = os.path.join(out_dir, "state.json")
        os.makedirs(out_dir, exist_ok=True)
        state = jsonstore.load(self.state_path, {})
        if not isinstance(state, dict) or state.get("version") != VERSION:
            state = {}
        self.finals = set(state.get("final", []))
        self.last_hour = None
        self._save_state()

    def _save_state(self):
        jsonstore.save(self.state_path, {"version": VERSION, "final": sorted(self.finals)})

    # --- frames ---------------------------------------------------------------

    def _frame(self, date, t):
        """The recorded frame at t, self.width wide, cached on disk; None if absent."""
        cache = os.path.join(self.dir, "cache", date)
        path = os.path.join(cache, f"{t:.3f}.jpg")
        data = None
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = f.read()
        else:
            try:
                data = self.frigate.snapshot(self.camera, round(t, 3),
                                             height=round(self.width * 9 / 16))
            except Exception as exc:
                log.debug("no frame at %.1f: %s", t, type(exc).__name__)
                return None
            os.makedirs(cache, exist_ok=True)
            _write(path, data)
        frame = _decode(data)
        if frame is None:
            return None
        if frame.shape[1] != self.width:
            height = round(frame.shape[0] * self.width / frame.shape[1])
            frame = cv2.resize(frame, (self.width, height), interpolation=cv2.INTER_AREA)
        return frame

    def _full_frame(self, t):
        try:
            return _decode(self.frigate.snapshot(self.camera, round(t, 3), height=self.source_height))
        except Exception as exc:
            log.debug("no full frame at %.1f: %s", t, type(exc).__name__)
            return None

    def _clean_full_frame(self, t):
        """The first frame of CLEAN_LAGS before t that is not smeared; None."""
        for lag in CLEAN_LAGS:
            frame = self._full_frame(t - lag)
            if frame is not None and not is_smeared(frame):
                return frame
        return None

    def _prune_cache(self, keep_from):
        root = os.path.join(self.dir, "cache")
        if not os.path.isdir(root):
            return
        for name in os.listdir(root):
            if DATE.match(name) and name < keep_from:
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)

    # --- making a day ---------------------------------------------------------

    def make(self, date):
        start, end = day_bounds(date)
        return self.make_range(date, start, min(end, self.clock()))

    def make_range(self, date, start, end):
        """Write <date>.json and <date>/ from Frigate data in [start, end)."""
        now = self.clock()
        events = self.frigate.events(after=start - EVENTS_BEFORE_S, before=end,
                                     cameras=[self.camera], limit=5000)
        events = [e for e in events if (e.get("end_time") or now) >= start]
        reviews = [r for r in self.frigate.reviews(after=start, before=end, limit=5000)
                   if r.get("camera") == self.camera]
        summaries = self.summaries(start - 1)
        by_review = {r["id"]: r for r in reviews}

        found = pet_moments(reviews, events, self.camera, self.pet.label, start, end)
        kept = keep_without_people(found, events)
        folder = os.path.join(self.dir, date)
        os.makedirs(folder, exist_ok=True)
        moments, smeared = [], 0
        for m in kept:
            name = f"{int(m['t'])}.jpg"
            path = os.path.join(folder, name)
            if not os.path.exists(path):
                frame = self._clean_full_frame(m["t"])
                if frame is None:
                    smeared += 1
                    continue
                _write(path, _jpeg(moment_image(frame, m["box"]), 82))
            summary = summaries.get(m["review"])
            moments.append(dict(m, image=f"{date}/{name}", summary=summary,
                                kind=moment_kind(by_review[m["review"]], summary, self.pet)))
        names = {os.path.basename(m["image"]) for m in moments} | {"rest.jpg"}
        for name in os.listdir(folder):  # moments dropped since the last run
            if IMAGE.match(name) and name not in names:
                os.remove(os.path.join(folder, name))

        labels, centres = cluster([centre(m["box"]) for m in moments])
        minutes = minutes_seen(events, self.pet.label, centres, start, end, now)
        counts = [sum(1 for v in minutes.values() if v == k) for k in range(len(centres))]
        sizes = [labels.count(k) for k in range(len(centres))]
        order = sorted(range(len(centres)), key=lambda k: (-counts[k], -sizes[k], k))
        new_id = {k: i for i, k in enumerate(order)}
        places = []
        for k in order:
            texts = [m["summary"] for m, lab in zip(moments, labels) if lab == k and m["summary"]]
            cx, cy = centres[k]
            places.append({"id": new_id[k], "name": place_name(texts), "x": round(cx, 4),
                           "y": round(min(cy / CLOCK_BAND, 1.0), 4), "minutes": counts[k]})
        for m, lab in zip(moments, labels):
            m["place"] = new_id[lab]

        rest = None
        if places:
            main = [m for m in moments if m["place"] == 0]
            if self._make_rest(date, events, start, end, main, centres[order[0]]):
                rest = f"{date}/rest.jpg"
        if rest is None and os.path.exists(os.path.join(folder, "rest.jpg")):
            os.remove(os.path.join(folder, "rest.jpg"))

        doc = {
            "date": date,
            "updated": int(now),
            "rest": rest,
            "main": {"place": 0, "minutes": places[0]["minutes"]} if places else None,
            "places": places,
            "ribbon": [dict(r, place=new_id[r["place"]]) for r in ribbon(minutes, start)],
            "moments": [{"t": m["t"], "place": m["place"], "image": m["image"], "kind": m["kind"],
                         "title": m["summary"]["title"] if m["summary"] else None,
                         "review": m["review"]} for m in moments],
            # A cat has no sound on the listen list; a bark there is another animal.
            "barks": barks(events, self.camera, start, end, now) if self.pet.sounds else [],
        }
        _write(os.path.join(self.dir, f"{date}.json"), json.dumps(doc).encode())
        log.info("pet day %s: %d moments (%d with a person dropped, %d with no clean "
                 "frame), %d places, rest %s", date, len(moments), len(found) - len(kept),
                 smeared, len(places), bool(rest))
        self._prune_cache((datetime.date.fromisoformat(date) - datetime.timedelta(days=1)).isoformat())
        return {"moments": len(moments), "dropped": len(found) - len(kept),
                "places": len(places), "rest": bool(rest)}

    def _make_rest(self, date, events, start, end, main, place_centre):
        """rest.jpg: the quiet room with one solid copy of the pet from a moment at the
        main place. False when no moment could be pasted."""
        quiet = []
        for t in background_times(events, start, end):
            frame = self._frame(date, t)
            if frame is not None and not is_smeared(frame):
                quiet.append((t, frame))
        # Daylight first, then nearest the place's centre.
        tries = []
        for m in sorted(main, key=lambda m: math.dist(centre(m["box"]), place_centre)):
            frame = self._frame(date, m["t"] - RECORDING_LAG_S)
            if frame is not None and not is_smeared(frame):
                tries.append((is_night(frame), m, frame))
            if len(tries) >= 2 * REST_TRIES:
                break
        tries.sort(key=lambda x: x[0])
        for night, m, frame in tries[:REST_TRIES]:
            same = [(t, f) for t, f in quiet if is_night(f) == night and f.shape == frame.shape]
            pool = _even(same, BG_FRAMES)
            if len(pool) < 3:
                continue
            background = base_picture([f for _, f in pool])
            near = sorted(same, key=lambda q: abs(q[0] - m["t"]))[:LOCAL_FRAMES]
            reference = np.median(np.stack([f for _, f in near]), axis=0).astype(np.uint8)
            picture, kept = composite(background, [(frame, m["box"], reference)])
            if kept:
                _write(os.path.join(self.dir, date, "rest.jpg"), _jpeg(cut_clock_band(picture)))
                return True
        for _night, m, frame in tries:
            if not person_boxes(events, m["t"]):
                log.info("rest picture %s: no moment could be pasted; the frame of %.0f", date, m["t"])
                picture = paint_out_tag(np.ascontiguousarray(cut_clock_band(frame)))
                _write(os.path.join(self.dir, date, "rest.jpg"), _jpeg(picture))
                return True
        return False

    # --- serving --------------------------------------------------------------

    def day(self, date):
        """The day document (without the story), or None."""
        if not DATE.match(date or ""):
            return None
        doc = jsonstore.load(os.path.join(self.dir, f"{date}.json"), None)
        return doc if isinstance(doc, dict) and doc.get("date") == date else None

    def days(self):
        """[{"date", "updated"}], newest date first."""
        out = []
        for name in os.listdir(self.dir):
            m = DAY_JSON.match(name)
            if m:
                doc = self.day(m.group(1))
                if doc:
                    out.append({"date": doc["date"], "updated": doc["updated"]})
        return sorted(out, key=lambda d: d["date"], reverse=True)

    def image(self, date, name):
        """The bytes of <date>/<name>; None for any other name or a missing file."""
        if not DATE.match(date or "") or not IMAGE.match(name or ""):
            return None
        try:
            with open(os.path.join(self.dir, date, name), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    # --- schedule -------------------------------------------------------------

    def step(self):
        """Today once an hour; the day before once, at FINAL_AT or later."""
        now = time.localtime(self.clock())
        today = time.strftime("%Y-%m-%d", now)
        yesterday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
        if (now.tm_hour, now.tm_min) >= FINAL_AT and yesterday not in self.finals:
            self.make(yesterday)
            self.finals = {d for d in self.finals if d >= yesterday} | {yesterday}
            self._save_state()
        hour = time.strftime("%Y-%m-%d %H", now)
        if hour != self.last_hour:
            self.last_hour = hour
            self.make(today)

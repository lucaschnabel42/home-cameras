"""One-line summaries of review items from the local vision model.

For each review item of the last LOOKBACK_S that has ended and has no
summary, newest first: three frames from the recordings (start + 2 s, the
middle, end - 2 s, at FRAME_HEIGHT), one Ollama /api/chat call with the
frames, format "json", and keep_alive "2m". The answer is stored as
{"title" <= 60 chars, "summary" <= 200 chars}. A bad answer is retried once,
RETRY_AFTER_S later, then skipped for good.

Summaries are off when OLLAMA_URL is empty. With GPU_GATE=nvidia they run
only when the GPU is free (gpu_free): the memory nvidia-smi reports, less what
the summary model holds (its size_vram plus OLLAMA_OVERHEAD_MIB), is under
GPU_FREE_MIB. Another program on the GPU then makes the summaries and the
story wait. With no gate (the default) they run whenever Ollama answers.

What this does not do:
- It does not watch the video, only three still frames, so a short visit
  between the frames is missed and the model may describe the wrong moment.
- It does not check the model's words. The prompt asks it to call the pet
  by its name and not to guess names; the model can still get either wrong.
- A stored summary keeps the words it was written with. A new camera name
  changes only the summaries written after it.
- It cannot see whether another program is about to use the GPU. A game
  started during a summary shares the GPU for up to about a minute.
- An Ollama outage is not a bad answer; the item waits for Ollama.

backlog() says how many ended items still wait for a summary; story.py
waits for it to be 0 before it writes a story.
"""

import base64
import json
import logging
import re
import subprocess
import threading
import urllib.request

import jsonstore
import names
from names import camera_name

MODEL = "qwen2.5vl:7b"
# Free means: what other programs hold (all memory in use, less the summary model
# and Ollama's overhead) is under this. A desktop with no other GPU program
# holds about 800 MiB, so a game or another model makes the summaries wait.
GPU_FREE_MIB = 2500
# One context size for every call of the model (summaries and stories): Ollama
# reloads the model when it changes.
NUM_CTX = 4096
# A title and a summary of 200 characters are well under this.
SUMMARY_MAX_TOKENS = 300
# What Ollama holds beyond the size_vram it reports for a loaded model.
# Measured: 755 MiB in use before, 7463 MiB with qwen2.5vl:7b loaded and its
# size_vram 5233 MiB, so 1475 MiB more.
OLLAMA_OVERHEAD_MIB = 1475
MIB = 1024 * 1024
LOOKBACK_S = 48 * 3600
KEEP_S = 7 * 86400
SETTLE_S = 60  # recordings of the last seconds are flushed by then
MIN_GAP_S = 20  # at most 3 calls a minute
RETRY_AFTER_S = 600
MAX_TRIES = 2
FRAME_HEIGHT = 480
TITLE_MAX, SUMMARY_MAX = 60, 200

OBJECT_WORDS = {"dog": "a dog", "person": "a person", "cat": "a cat"}
SOUND_WORDS = {"bark": "a dog barking", "howl": "a dog howling",
               "smoke_detector": "a smoke alarm", "fire_alarm": "a fire alarm",
               "shatter": "breaking glass"}
# The pet's own sounds, named with the pet's name.
PET_SOUND_VERBS = {"bark": "barking", "howl": "howling"}

log = logging.getLogger("cam-helper.summaries")


def nvidia_smi(argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, check=True).stdout


def gpu_free(run=nvidia_smi, get_ps=None):
    """True when the GPU is free for a summary; False when unknown."""
    try:
        out = run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        values = [int(v) for v in out.split()]
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    if not values:
        return False
    try:
        models = get_ps().get("models", []) if get_ps else []
    except Exception:
        models = []
    ours = sum(m.get("size_vram", 0) for m in models
               if MODEL in (m.get("name"), m.get("model"))) / MIB
    if ours > 0:
        ours += OLLAMA_OVERHEAD_MIB
    return sum(values) - ours < GPU_FREE_MIB


def ollama_ps(base):
    def get():
        with urllib.request.urlopen(base.rstrip("/") + "/api/ps", timeout=5) as r:
            return json.loads(r.read())
    return get


def ollama_chat(base, timeout=300):
    def chat(body):
        req = urllib.request.Request(base.rstrip("/") + "/api/chat", method="POST",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())["message"]["content"]
    return chat


def _words(pet):
    """(object words, sound words) with the pet's name in place of its label."""
    objects, sounds = dict(OBJECT_WORDS), dict(SOUND_WORDS)
    if pet:
        objects[pet.label] = f"{pet.name} (the {pet.label})"
        for label in pet.sounds:
            sounds[label] = f"{pet.name} {PET_SOUND_VERBS[label]}"
    return objects, sounds


def build_prompt(review, frames, pet=None, title_of=camera_name):
    """The user message for one review item. pet is a pet.Pet, or None.
    title_of gives the title of the camera (names.Names.title)."""
    data = review.get("data") or {}
    object_words, sound_words = _words(pet)
    seen = [object_words.get(o, o) for o in data.get("objects", [])]
    heard = [sound_words.get(a, a) for a in data.get("audio", [])]
    length = round((review["end_time"] or review["start_time"]) - review["start_time"])
    lines = [
        f"These are {frames} frames, in time order, from the home camera "
        f"\"{title_of(review['camera']) or camera_name(review['camera'])}\". They cover {length} seconds.",
        "The camera detected: " + (", ".join(seen) or "nothing named") + ".",
    ]
    if heard:
        lines.append("The camera heard: " + ", ".join(heard) + ".")
    if pet:
        lines.append(
            f"The {pet.label} in this home is {pet.name}, a {pet.sex} {pet.label}. Always call "
            f"{pet.him} \"{pet.name}\" or \"{pet.he}\", never \"the {pet.label}\". "
            "Do not guess names of people; say \"a person\".")
        example = f"{pet.name} naps on the couch"
    else:
        lines.append("Do not guess names of people or animals; say \"a person\", \"a dog\" "
                     "or \"a cat\".")
        example = "A person walks to the door"
    lines += [
        "Say what happens, plainly. Do not invent anything you cannot see.",
        "Answer with JSON only: {\"title\": \"...\", \"summary\": \"...\"}.",
        f"title: at most {TITLE_MAX} characters, like \"{example}\".",
        f"summary: one or two short sentences, at most {SUMMARY_MAX} characters.",
    ]
    return "\n".join(lines)


def _clip(text, limit):
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    if " " in cut:
        cut = cut[:cut.rfind(" ")]
    return cut.rstrip(" ,.;:-") + "…"


def name_words(pet):
    """The words of the pet's name, which keep their capital in a title."""
    return frozenset(pet.name.replace("-", " ").split()) if pet else frozenset()


def title_words(camera, title):
    """The words of a user's camera name that keep their capital in a summary
    title (names.proper_words). The derived name adds none, as before."""
    if not title or title == camera_name(camera):
        return frozenset()
    return names.proper_words(title)


def sentence_case(title, keep=frozenset()):
    """"Rex Investigates Near Couch" -> "Rex investigates near couch".

    Only a Title Case answer (every word after the first capitalised) is
    changed; acronyms such as TV and the words in keep stay as they are.
    """
    words = title.split(" ")
    rest = [w for w in words[1:] if any(ch.isalpha() for ch in w)]
    if len(rest) < 2 or not all(w[0].isupper() for w in rest):
        return title
    out = [words[0]]
    for w in words[1:]:
        out.append(w if w in keep or (len(w) > 1 and w.isupper()) else w[:1].lower() + w[1:])
    return " ".join(out)


def parse_answer(content, keep=frozenset()):
    """{"title", "summary"} from the model's answer, or None if it is bad.
    keep: the words that keep their capital in the title (name_words)."""
    try:
        value = json.loads(content)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    out = {}
    for key, limit in (("title", TITLE_MAX), ("summary", SUMMARY_MAX)):
        text = value.get(key)
        if not isinstance(text, str):
            return None
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return None
        out[key] = _clip(sentence_case(text, keep) if key == "title" else text, limit)
    return out


def frame_times(start, end):
    if end - start >= 4:
        return [start + 2, (start + end) / 2, end - 2]
    return [start, (start + end) / 2, end]


class Summarizer:
    """Makes at most one summary per step(); app.py calls step() every 20 s.
    pet is a pet.Pet, or None. title_of gives the title of a camera
    (names.Names.title)."""

    def __init__(self, frigate, chat, gpu_check, store_path, clock, pet=None,
                 title_of=camera_name):
        self.frigate = frigate
        self.title_of = title_of
        self.pet = pet
        self.keep = name_words(pet)
        self.chat = chat
        self.gpu_check = gpu_check
        self.path = store_path
        self.clock = clock
        self.lock = threading.Lock()
        store = jsonstore.load(store_path, {})
        self.done = store.get("done", {}) if isinstance(store, dict) else {}
        self.failed = store.get("failed", {}) if isinstance(store, dict) else {}
        self.last_try = None
        self.was_free = None
        self.pending = None  # {review id: start} waiting for a summary; None: not looked yet

    def _save(self):
        jsonstore.save(self.path, {"done": self.done, "failed": self.failed})

    def summaries(self, after):
        with self.lock:
            return {rid: {"title": sentence_case(s["title"], self.keep), "summary": s["summary"]}
                    for rid, s in self.done.items() if s["start"] >= after}

    def backlog(self, after=None, before=None):
        """How many ended review items wait for a summary, by start time in
        [after, before). An item waiting for its retry counts; one given up
        does not. None until step() has looked at Frigate once."""
        if self.pending is None:
            return None
        with self.lock:
            starts = list(self.pending.values())
        return sum(1 for t in starts
                   if (after is None or t >= after) and (before is None or t < before))

    def _next_review(self, now):
        items = self.frigate.reviews(after=now - LOOKBACK_S)
        pending, ready = {}, None
        for r in sorted(items, key=lambda r: r["start_time"], reverse=True):
            if r.get("end_time") is None or r["end_time"] > now - SETTLE_S:
                continue
            if r["id"] in self.done:
                continue
            fail = self.failed.get(r["id"])
            if fail and fail["tries"] >= MAX_TRIES:
                continue
            pending[r["id"]] = r["start_time"]
            if ready is None and not (fail and now < fail["next"]):
                ready = r
        with self.lock:
            self.pending = pending
        return ready

    def _fail(self, review, now, why):
        fail = self.failed.get(review["id"], {"tries": 0})
        fail = {"tries": fail["tries"] + 1, "next": now + RETRY_AFTER_S,
                "start": review["start_time"]}
        with self.lock:
            self.failed[review["id"]] = fail
            if fail["tries"] >= MAX_TRIES and self.pending is not None:
                self.pending.pop(review["id"], None)
            self._save()
        log.warning("summary of %s failed (%s), try %d of %d",
                    review["id"], why, fail["tries"], MAX_TRIES)

    def step(self):
        now = self.clock()
        if self.last_try is not None and now - self.last_try < MIN_GAP_S:
            return
        review = self._next_review(now)
        if review is None:
            return
        free = self.gpu_check()
        if free != self.was_free:
            log.info("GPU %s for summaries", "free" if free else "busy; summaries wait")
            self.was_free = free
        if not free:
            return
        self.last_try = now
        images = []
        for t in frame_times(review["start_time"], review["end_time"]):
            try:
                jpeg = self.frigate.snapshot(review["camera"], round(t, 3), FRAME_HEIGHT)
            except Exception as exc:
                log.info("no frame at %s for %s: %s", t, review["id"], type(exc).__name__)
                continue
            images.append(base64.b64encode(jpeg).decode())
        if not images:
            self._fail(review, now, "no frames")
            return
        body = {"model": MODEL, "stream": False, "format": "json", "keep_alive": "2m",
                # num_predict: JSON mode can pad with whitespace without end.
                "options": {"temperature": 0.2, "num_ctx": NUM_CTX, "num_predict": SUMMARY_MAX_TOKENS},
                "messages": [{"role": "user",
                              "content": build_prompt(review, len(images), self.pet,
                                                       self.title_of),
                              "images": images}]}
        started = self.clock()
        try:
            content = self.chat(body)
        except Exception as exc:
            log.warning("Ollama call failed: %s", type(exc).__name__)
            return
        camera = review["camera"]
        answer = parse_answer(content, self.keep | title_words(camera, self.title_of(camera)))
        if answer is None:
            self._fail(review, now, "bad answer")
            return
        with self.lock:
            self.done[review["id"]] = dict(answer, start=review["start_time"],
                                           camera=review["camera"])
            self.failed.pop(review["id"], None)
            if self.pending is not None:
                self.pending.pop(review["id"], None)
            cutoff = now - KEEP_S
            self.done = {k: v for k, v in self.done.items() if v["start"] >= cutoff}
            self.failed = {k: v for k, v in self.failed.items() if v.get("start", now) >= cutoff}
            self._save()
        log.info("summary of %s in %.1f s: %s", review["id"], self.clock() - started,
                 answer["title"])

"""The story of the pet day: episodes, the prompt, the checker, the schedule.

The pet comes from the settings (pet.py); every rule below names it.

- Only review items on the pet camera with the pet's label in objects or the
  pet's own sound in audio take part (pet_items); person-only items never
  reach the model.
- Notes: up to NOTES distinct cleaned summaries per episode, those naming an
  object first (the object rule reads only these notes).
- Episodes: items with a summary, in time order, are grouped while they are
  of one kind (pet_day.moment_kind) and less than EPISODE_GAP_S apart. An
  item without a summary breaks the episode and joins a run; each run becomes
  a code-written chapter ("The camera heard Rex bark 13 times...").
- The model (qwen2.5vl:7b, format json, keep_alive 2m) gets the episodes
  with their part of the day and up to NOTES cleaned summaries each, never a
  clock time, and writes a title and 1 to MAX_CHAPTERS chapters that name
  their episode ids. The code adds every time and every moment.
- check() lists every broken rule. A story that breaks any is not shown: one
  retry with the errors, then a code-written template (all chapters code).
- Schedule (StoryWriter.step): today's "so far" story at most once an hour,
  when the GPU is free, no summary waits (Summarizer.backlog() == 0), and at
  least NEW_SUMMARIES more pet summaries exist than at the last story. The
  final story of yesterday after FINAL_FROM once its summaries are done and
  the GPU is free, or at FINAL_BY whatever the state (the template when the
  GPU is busy or Ollama fails). A final story is never rewritten, except that
  a template final gets one try with the model when the GPU next frees.

What this does not do:
- It cannot check that a sentence is true, only that its words keep to the
  rules: tone words ("flopped", "patrol") pass, and a verb the notes never
  said ("ran") passes too. Objects, people, numbers, and times are checked.
- The kind of an episode comes from word lists over the summary, so a
  summary that says "plays on the couch" for a pet that only stood is play.
- The other-animal rule (a cat in the story of a dog, a dog in the story of
  a cat) reads Frigate events of that label on this camera only.
- The room word of the prompt is the title of the pet camera (the user's
  name, else the derived name). The capital rule also allows the words of a
  user's name that keep their capital (names.proper_words: "TV", "Emma's").
  It does not allow a capital that the derived name would add.
- Ordinals "first" and "second" pass the number rule (they order, they do
  not count); "third" and up are rejected.
"""

import datetime
import json
import logging
import re
import time

import numpy as np

import alerts
import jsonstore
import names
import pet_day
import summaries

MODEL = "qwen2.5vl:7b"
EPISODE_GAP_S = 20 * 60
NOTES = 3
NOTE_MAX = 160
MAX_CHAPTERS = 6
MAX_SENTENCES = 3
TITLE_MAX = 60
OTHER_ANIMAL_NEAR_S = 300
NEW_SUMMARIES = 3
EVERY_S = 3600
FINAL_FROM = (0, 10)
FINAL_BY = (6, 0)

log = logging.getLogger("cam-helper.story")

# --- word lists for the checker ------------------------------------------------------

NUMBER_WORDS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "dozen",
    "dozens", "once", "twice", "thrice", "third", "fourth", "fifth", "sixth", "seventh",
    "eighth", "ninth", "tenth", "eleventh", "twelfth"}
PERSON_WORDS = {"man", "men", "woman", "women", "mom", "moms", "mum", "dad", "dads", "owner",
                "owners", "husband", "wife", "boyfriend", "girlfriend"}
THOUGHT_WORDS = {
    "think", "thinks", "thinking", "thought", "thoughts", "dream", "dreams", "dreaming",
    "dreamed", "dreamt", "want", "wants", "wanting", "wanted", "hope", "hopes", "hoping",
    "hoped", "wish", "wishes", "wishing", "wished", "decide", "decides", "deciding",
    "decided", "plan", "plans", "planning", "planned"}
# A story of six chapters of three sentences is about 400 tokens of JSON.
STORY_MAX_TOKENS = 900
CALENDAR_CAPITALS = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                    "Saturday", "Sunday", "January", "February", "March", "April", "May",
                    "June", "July", "August", "September", "October", "November", "December"}
# Objects the model must not invent: each must be in the chapter's own notes.
# "cat" stands for the other animal: a dog for the story of a cat (_objects).
OBJECTS = ["ball", "toy", "treat", "cat", "door", "food", "bowl", "window", "bed", "blanket",
           "shoe", "sock", "stuffing", "bone", "stick", "rope", "feather", "pillow", "cushion",
           "leash", "bird", "squirrel", "paper", "clothes", "box", "slipper", "plant", "fabric",
           "towel", "bag", "chew", "squeaker"]
# Local minutes of the day each part-of-day word may touch.
PART_WINDOWS = {
    "morning": [(5 * 60, 12 * 60)],
    "lunchtime": [(11 * 60 + 30, 14 * 60)],
    "noon": [(11 * 60 + 30, 12 * 60 + 30)],
    "midday": [(11 * 60 + 30, 12 * 60 + 30)],
    "afternoon": [(12 * 60, 17 * 60 + 30)],
    "evening": [(17 * 60, 21 * 60 + 30)],
    "night": [(0, 5 * 60 + 30), (20 * 60 + 30, 24 * 60)],
    "midnight": [(0, 60), (23 * 60, 24 * 60)],
}
PART_WORDS = {"morning": "morning", "mornings": "morning", "lunchtime": "lunchtime",
              "noon": "noon", "midday": "midday", "afternoon": "afternoon",
              "afternoons": "afternoon", "evening": "evening", "evenings": "evening",
              "night": "night", "nights": "night", "tonight": "night", "overnight": "night",
              "nighttime": "night", "midnight": "midnight"}

# Sentences of a summary that say nothing about the pet; dropped from the notes.
FILLER = re.compile(r"^(the scene|the living room (remains|is|features)|the room (remains|is|"
                    r"features)|a person is not visible|there (is|are) no|no other|nothing else)",
                    re.I)
_WORD = re.compile(r"[A-Za-z][A-Za-z'’]*")
# "on the couch", "by the window": a place phrase may repeat. A napping dog is
# on the couch in most sentences, and the repeat rule rejected every nap story.
_PLACE_PHRASE_WORDS = {"couch", "sofa", "floor", "rug", "kitchen", "window", "door", "table",
                       "bed", "room", "blanket"}
_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def _allowed_capitals(pet, title=None):
    """The words that keep a capital inside a sentence: the pet's name, the
    days, the months, and the proper words of a user's name of the pet camera
    (title; None or the derived name adds none). A possessive is also kept
    without its 's, because the checks compare the word without it."""
    allowed = CALENDAR_CAPITALS | set(pet.name.replace("-", " ").split())
    if title and title != alerts.camera_name(pet.camera):
        for w in names.proper_words(title):
            allowed |= {w, re.sub(r"['’]s$", "", w)}
    return allowed


def _objects(pet):
    """OBJECTS for this pet: the other animal takes the place of "cat"."""
    return [pet.other_animal if noun == "cat" else noun for noun in OBJECTS]


def _object_of(word, pet):
    """The object a word names (plurals too), or None."""
    w = word.lower()
    for noun in _objects(pet):
        if w in (noun, noun + "s", noun + "es"):
            return noun
    return None


def _objects_in(text, pet):
    return {n for n in (_object_of(w, pet) for w in _WORD.findall(text)) if n}


# --- items and episodes --------------------------------------------------------------------

def pet_items(reviews, pet, start, end):
    """Review items on the pet camera with the pet in objects or the pet's
    own sound in audio, oldest first."""
    out = []
    for r in reviews:
        data = r.get("data") or {}
        if r.get("camera") != pet.camera or not start <= r["start_time"] < end:
            continue
        if pet.label in (data.get("objects") or []) or set(data.get("audio") or []) & pet.sounds:
            out.append(r)
    return sorted(out, key=lambda r: r["start_time"])


def _end(r):
    return r.get("end_time") or r["start_time"]


def clean_note(text, pet):
    """A summary made fit to show the model: the pet's name in place of "the
    dog" (or "the cat"), and no cut-off tail."""
    t = re.sub(r"\s+", " ", text or "").strip()
    if t.endswith("…") or t.endswith("�"):
        t = t.rstrip("…�")
        cut = max(t.rfind(". "), t.rfind("! "), t.rfind("? "))
        t = t[:cut + 1] if cut > 0 else t.rstrip(" ,;:") + "."
    kept = [x for x in _SENTENCE.split(t) if not FILLER.match(x)]
    t = " ".join(kept) if kept else t
    name, label = re.escape(pet.name), pet.label
    colour = r"(?: black| white| grey| gray| brown| orange| tabby| male| female)?"
    t = re.sub(rf"\b(?:the|a){colour} {label},? {name}(?: the {label})?,?", pet.name, t,
               flags=re.I)
    t = re.sub(rf"\b{name},? (?:the|a){colour} {label},?", pet.name, t)
    t = re.sub(rf"\b(?:the|a){colour} {label}\b", pet.name, t, flags=re.I)
    if len(t) > NOTE_MAX:
        cut = t[:NOTE_MAX]
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        t = cut[:end + 1] if end > 0 else cut[:cut.rfind(" ")].rstrip(" ,;:") + "."
    return t


def _pick_notes(texts, pet):
    distinct = []
    for t in texts:
        if t and t not in distinct:
            distinct.append(t)
    if len(distinct) <= NOTES:
        return distinct
    # Notes that name an object first: an object the model may only use when
    # its chapter's notes name it, so a dropped note would forbid a real one.
    chosen = [t for t in distinct if _objects_in(t, pet)][:NOTES]
    rest = [t for t in distinct if t not in chosen]
    need = NOTES - len(chosen)
    if need:
        chosen += [rest[i] for i in np.linspace(0, len(rest) - 1, need).round().astype(int)]
    return [t for t in distinct if t in chosen]


def build_episodes(items, summaries, pet):
    """(episodes, runs) from items (oldest first) and {review id: summary}.

    An episode: {id, kind, must, start, end, items, spans, notes}. A run of
    items without a summary: {start, end, items}."""
    episodes, runs, cur, run = [], [], None, None
    for r in items:
        summary = summaries.get(r["id"])
        if summary is None:
            cur = None
            if run is None:
                run = {"start": r["start_time"], "end": _end(r), "items": []}
                runs.append(run)
            run["items"].append(r["id"])
            run["end"] = max(run["end"], _end(r))
            continue
        run = None
        kind = pet_day.moment_kind(r, summary, pet)
        if cur is not None and cur["kind"] == kind and r["start_time"] - cur["end"] < EPISODE_GAP_S:
            cur["items"].append(r["id"])
            cur["spans"].append((r["start_time"], _end(r)))
            cur["end"] = max(cur["end"], _end(r))
            cur["texts"].append(clean_note(summary.get("summary") or summary.get("title"), pet))
            continue
        cur = {"id": f"e{len(episodes) + 1}", "kind": kind, "must": kind in pet_day.RARE_KINDS,
               "start": r["start_time"], "end": _end(r), "items": [r["id"]],
               "spans": [(r["start_time"], _end(r))],
               "texts": [clean_note(summary.get("summary") or summary.get("title"), pet)]}
        episodes.append(cur)
    for e in episodes:
        e["notes"] = _pick_notes(e.pop("texts"), pet)
    return episodes, runs


def _minute(t):
    lt = time.localtime(t)
    return lt.tm_hour * 60 + lt.tm_min


def part_of_day(t):
    m = _minute(t)
    if m < 5 * 60 or m >= 21 * 60:
        return "night"
    if m < 12 * 60:
        return "morning"
    if m < 17 * 60:
        return "afternoon"
    return "evening"


# --- the prompt ------------------------------------------------------------------------------

SYSTEM = """You write a short, warm story of one day in the life of {name}, a {sex} {label}, for the people {he} lives with. They read it on a phone.

Facts come ONLY from the episodes below. Each episode is something the {room} camera saw. If an episode does not say it, it did not happen.

Rules:
- {name} is "{name}" or "{he}". Never {wrong}, "it", or "the {label}".
- People: say "someone" or "{his} people". Never a name, and never man, woman, mom, dad, owner, husband, wife, boyfriend or girlfriend. Mention a person only when they do something with {name}.
- Write no numbers at all: no digits and no number words such as one, two, twice or third. The app adds every time and every count.
- Use morning, lunchtime, afternoon, evening or night only when it fits the "part" of the episodes in that chapter.
- Describe what {he} did and how it looked (curled up, sniffing, ran after the ball). Never say what {he} thought, wanted, dreamed, hoped, wished, decided or planned.
- Name an object (ball, toy, treat, blanket, door, window, food, {other}...) only when a note of that chapter's own episodes names it.
- Use a capital letter only to start a sentence, and for {name} and the names of days and months.
- Do not guess why {he} was off camera. The camera sees one room only.
- Each chapter lists the ids of the episodes it tells. Every episode marked "must": true is in some chapter. An episode is in at most one chapter.
- Between 1 and 6 chapters, in time order, each one to three short sentences. No two chapters start with the same words. Do not repeat a phrase.
- Plain, light, a little funny. No exclamation marks.
- title: at most 48 characters, from the day's real events, with no numbers.

Answer with JSON only: {{"title": "...", "chapters": [{{"episodes": ["e1", "e2"], "text": "..."}}]}}"""


def _said_pronouns(pet):
    """The wrong pronouns as the prompt and the checker name them."""
    return sorted(pet.wrong_pronouns - {"hers", "herself", "himself"})


def room_words(camera, title=None):
    """The title of the pet camera as it reads in the prompt: rule 1 of the
    place phrase (names.in_sentence). With no title, the derived name."""
    return names.in_sentence(title or alerts.camera_name(camera))


def system_prompt(pet, title=None):
    """SYSTEM with the pet's name, sex, label, pronouns, and the title of the
    pet camera (None: the derived name) filled in."""
    return SYSTEM.format(
        name=pet.name, sex=pet.sex, label=pet.label, he=pet.he, his=pet.his,
        other=pet.other_animal, room=room_words(pet.camera, title),
        wrong=", ".join(f'"{w}"' for w in _said_pronouns(pet)))


def build_prompt(date, episodes, final, pet, title=None):
    """(system, user) messages for the story call. title is the title of the
    pet camera (None: the derived name)."""
    weekday = datetime.date.fromisoformat(date).strftime("%A")
    when = ("This is the story of the whole day." if final
            else "This is the story so far; the day is not over yet.")
    listed = []
    for e in episodes:
        item = {"id": e["id"], "part": part_of_day(e["start"]), "kind": e["kind"]}
        if e["must"]:
            item["must"] = True
        item["notes"] = e["notes"]
        listed.append(item)
    user = (f"Day: {weekday}. {when}\n"
            "Episodes in time order (\"part\" is the part of the day; \"notes\" are what the "
            "camera saw):\n" + json.dumps(listed, indent=1, ensure_ascii=False))
    return system_prompt(pet, title), user


def parse_answer(content, pet, title=None):
    """The model's JSON. A Title Case title ("A Quiet Day Stroll") is made a
    sentence first, as summary titles are: the capitals rule is for names."""
    try:
        answer = json.loads(content)
    except (TypeError, ValueError):
        return None
    if isinstance(answer, dict) and isinstance(answer.get("title"), str):
        answer["title"] = title_sentence(answer["title"].strip(), pet, title)
    return answer


def title_sentence(title, pet, camera_title=None):
    """"Rex's Day of Rest" -> "Rex's day of rest": after the first word, a
    capital stays only on the pet's name, a day, or a month. The model writes
    titles in full or partial Title Case. camera_title is the title of the
    pet camera (_allowed_capitals)."""
    allowed = _allowed_capitals(pet, camera_title)
    out, first = [], True
    for m in re.finditer(r"\S+", title):
        w = m.group(0)
        base = re.sub(r"['’]s$", "", re.sub(r"[^A-Za-z'’]", "", w))
        if (not first and w[:1].isupper() and base not in allowed
                and not (len(base) > 1 and base.isupper())):
            w = w[0].lower() + w[1:]
        out.append(w)
        first = False
    return " ".join(out)


# --- the checker ------------------------------------------------------------------------------

def _sentences(text):
    return [x for x in _SENTENCE.split(text.strip()) if x.strip()]


def _word_checks(text, where, pet, title=None):
    """Errors for the rules that look at single words (title and chapters).
    title is the title of the pet camera (_allowed_capitals)."""
    errors = []
    if re.search(r"\d", text):
        errors.append(f"{where}: write no digits.")
    words = _WORD.findall(text)
    lower = [w.lower().rstrip("'’") for w in words]
    never = " or ".join(f'"{w}"' for w in _said_pronouns(pet))
    for bad, rule in ((NUMBER_WORDS, "write no number words"),
                      (pet.wrong_pronouns, f"{pet.name} is a {pet.sex}; never write {never}"),
                      (PERSON_WORDS, f'say "someone" or "{pet.his} people" for a person'),
                      (THOUGHT_WORDS, f"never say what {pet.name} thought, wanted, dreamed, "
                                      "hoped, wished, decided or planned")):
        hit = sorted({w for w in lower if w in bad})
        if hit:
            errors.append(f"{where}: {rule} (found: {', '.join(hit)}).")
    if re.search(rf"\bthe {pet.label}\b", text, re.I):
        errors.append(f'{where}: do not write "the {pet.label}"; '
                      f'write "{pet.name}" or "{pet.he}".')
    starts = {m.start(1) for m in re.finditer(r"(?:^|[.!?]['\"”’)]*\s+)[\"“‘(]*([A-Za-z])", text)}
    caps = []
    allowed = _allowed_capitals(pet, title)
    for m in _WORD.finditer(text):
        w = m.group(0)
        base = re.sub(r"['’]s$", "", w)
        if w[0].isupper() and m.start() not in starts and base not in allowed:
            caps.append(w)
    if caps:
        errors.append(f"{where}: use capitals only to start a sentence and for {pet.name}, days "
                      f"and months (found: {', '.join(sorted(set(caps)))}).")
    return errors


def _parts_ok(text, start, end):
    """Part-of-day words in text that do not fit [start, end]."""
    a, b = _minute(start), _minute(end)
    if b < a:
        b = 24 * 60
    wrong = []
    for w in _WORD.findall(text):
        part = PART_WORDS.get(w.lower())
        if part and not any(lo <= b and a <= hi for lo, hi in PART_WINDOWS[part]):
            wrong.append(w.lower())
    return wrong


def check(answer, episodes, other_events, pet, camera_title=None):
    """Every broken rule as a sentence for the model; [] when the story passes.

    other_events: Frigate events of the other animal (pet.other_animal).
    camera_title: the title of the pet camera (_allowed_capitals)."""
    if not isinstance(answer, dict):
        return ["Answer with one JSON object: {\"title\": \"...\", \"chapters\": [...]}."]
    errors = []
    title, chapters = answer.get("title"), answer.get("chapters")
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > TITLE_MAX:
        errors.append(f"title: write a title of 1 to {TITLE_MAX} characters.")
        title = ""
    if not isinstance(chapters, list) or not 1 <= len(chapters) <= MAX_CHAPTERS:
        return errors + [f"Write 1 to {MAX_CHAPTERS} chapters."]
    by_id = {e["id"]: e for e in episodes}
    used, firsts, trigrams = {}, {}, {}
    for n, ch in enumerate(chapters, 1):
        where = f"chapter {n}"
        if (not isinstance(ch, dict) or not isinstance(ch.get("text"), str)
                or not ch["text"].strip() or not isinstance(ch.get("episodes"), list)
                or not ch["episodes"] or not all(isinstance(i, str) for i in ch["episodes"])):
            errors.append(f"{where}: give \"episodes\" (a list of ids) and \"text\".")
            continue
        text = ch["text"].strip()
        unknown = [i for i in ch["episodes"] if i not in by_id]
        if unknown:
            errors.append(f"{where}: there is no episode {', '.join(unknown)}.")
        for i in ch["episodes"]:
            if i in used and i in by_id:
                errors.append(f"{where}: episode {i} is already in chapter {used[i]}.")
            used.setdefault(i, n)
        if not 1 <= len(_sentences(text)) <= MAX_SENTENCES:
            errors.append(f"{where}: write one to {MAX_SENTENCES} sentences.")
        errors += _word_checks(text, where, pet, camera_title)
        mine = [by_id[i] for i in ch["episodes"] if i in by_id]
        if not mine:
            continue
        notes = " ".join(" ".join(e["notes"]) for e in mine)
        missing = sorted(_objects_in(text, pet) - _objects_in(notes, pet))
        if missing:
            errors.append(f"{where}: the notes of its episodes do not mention "
                          f"{', '.join(missing)}; leave {'it' if len(missing) == 1 else 'them'} out.")
        other = pet.other_animal
        if other in _objects_in(text, pet) and other not in missing:
            spans = [s for e in mine for s in e["spans"]]
            if not any(c.get("label") == other and c["start_time"] <= b + OTHER_ANIMAL_NEAR_S
                       and (c.get("end_time") or c["start_time"]) >= a - OTHER_ANIMAL_NEAR_S
                       for c in other_events for a, b in spans):
                errors.append(f"{where}: the camera saw no {other} then; leave the {other} out.")
        start, end = min(e["start"] for e in mine), max(e["end"] for e in mine)
        wrong = _parts_ok(text, start, end)
        if wrong:
            errors.append(f"{where}: {', '.join(sorted(set(wrong)))} does not fit the time of its "
                          f"episodes (part: {part_of_day(start)}).")
        words = [w.lower() for w in _WORD.findall(text)]
        first = " ".join(words[:3])
        if first in firsts:
            errors.append(f"{where}: starts with the same words as chapter {firsts[first]} "
                          f"(\"{first}\").")
        firsts.setdefault(first, n)
        for sentence in _sentences(text):
            sw = [w.lower() for w in _WORD.findall(sentence)]
            for k in range(len(sw) - 2):
                if sw[k + 1] == "the" and sw[k + 2] in _PLACE_PHRASE_WORDS:
                    continue
                tri = " ".join(sw[k:k + 3])
                trigrams[tri] = trigrams.get(tri, 0) + 1
    for i, e in by_id.items():
        if e["must"] and i not in used:
            errors.append(f"Episode {i} ({e['kind']}) must be in a chapter.")
    repeated = sorted(t for t, c in trigrams.items() if c > 2)
    if repeated:
        errors.append(f"Do not repeat a phrase more than twice (found: {'; '.join(repeated)}).")
    if title:
        errors += _word_checks(title, "title", pet, camera_title)
        all_notes = " ".join(" ".join(e["notes"]) for e in episodes)
        missing = sorted(_objects_in(title, pet) - _objects_in(all_notes, pet))
        if missing:
            errors.append(f"title: no note mentions {', '.join(missing)}.")
        if episodes:
            wrong = _parts_ok(title, min(e["start"] for e in episodes),
                              max(e["end"] for e in episodes))
            if wrong:
                errors.append(f"title: {', '.join(sorted(set(wrong)))} does not fit the day.")
    return errors


# --- chapters ------------------------------------------------------------------------------------

def _moments(item_ids, moments_by_review):
    return sorted(moments_by_review[i] for i in item_ids if i in moments_by_review)


def _times(n, one="once"):
    return one if n == 1 else f"{n} times"


def code_chapter(run, items_by_id, moments_by_review, events, pet, now):
    """The code-written chapter for items that have no summary yet."""
    heard = [alerts._heard(e, now)[0] for e in events
             if e.get("label") in pet.sounds and e.get("camera") == pet.camera]
    barks = sum(1 for t in heard if run["start"] <= t <= run["end"])
    seen = sum(1 for i in run["items"]
               if pet.label in ((items_by_id.get(i) or {}).get("data") or {}).get("objects", []))
    parts = []
    if barks:
        parts.append(f"The camera heard {pet.name} bark {_times(barks)}. Tap to listen.")
    if seen == 1:
        parts.append(f"{pet.name} was on camera once; that moment has no description yet.")
    elif seen:
        parts.append(f"{pet.name} was on camera {seen} times; these moments have no "
                     "description yet.")
    if not parts:
        parts.append(f"The camera heard {pet.name}. Tap to listen.")
    return {"start": run["start"], "end": run["end"], "text": " ".join(parts),
            "moments": _moments(run["items"], moments_by_review), "code": True}


def assemble(answer, episodes, runs, items_by_id, moments_by_review, events, pet, final, now):
    """The story document from a checked answer."""
    by_id = {e["id"]: e for e in episodes}
    chapters = []
    for ch in answer["chapters"]:
        mine = [by_id[i] for i in ch["episodes"]]
        chapters.append({"start": min(e["start"] for e in mine), "end": max(e["end"] for e in mine),
                         "text": re.sub(r"\s+", " ", ch["text"]).strip(),
                         "moments": _moments([i for e in mine for i in e["items"]], moments_by_review),
                         "code": False})
    chapters += [code_chapter(r, items_by_id, moments_by_review, events, pet, now) for r in runs]
    chapters.sort(key=lambda c: c["start"])
    return {"title": answer["title"].strip(), "final": final, "written": int(now),
            "chapters": chapters}


KIND_PHRASES = {"nap": "napped", "rest": "rested", "floor": "lay on the floor",
                "walk": "walked around the room", "play": "played",
                "with-person": "spent time with someone", "bark": "barked",
                "other": "was on camera"}
PART_OPENERS = {"morning": "In the morning", "afternoon": "In the afternoon",
                "evening": "In the evening", "night": "At night"}


def template(episodes, runs, items_by_id, moments_by_review, events, pet, final, now):
    """The code-written story: one chapter per part of the day, listing the
    kinds of its episodes in order, plus the code chapters of the runs."""
    groups = []
    for e in episodes:
        part = part_of_day(e["start"])
        if groups and groups[-1][0] == part:
            groups[-1][1].append(e)
        else:
            groups.append((part, [e]))
    chapters = []
    for part, eps in groups:
        phrases = []
        for e in eps:
            p = KIND_PHRASES.get(e["kind"], KIND_PHRASES["other"])
            if p not in phrases:
                phrases.append(p)
        said = phrases[0] if len(phrases) == 1 else ", ".join(phrases[:-1]) + " and " + phrases[-1]
        chapters.append({"start": min(e["start"] for e in eps), "end": max(e["end"] for e in eps),
                         "text": f"{PART_OPENERS[part]} {pet.name} {said}.",
                         "moments": _moments([i for e in eps for i in e["items"]], moments_by_review),
                         "code": True})
    chapters += [code_chapter(r, items_by_id, moments_by_review, events, pet, now) for r in runs]
    chapters.sort(key=lambda c: c["start"])
    title = f"{pet.name}'s day" if final else f"{pet.name}'s day so far"
    return {"title": title, "final": final,
            "written": int(now), "chapters": chapters}


# --- the writer and its schedule -------------------------------------------------------------------

class StoryWriter:
    """Writes and keeps the stories. pet_days is a pet_day.PetDay; summarizer
    a summaries.Summarizer (summaries(after), backlog(after, before)).
    title_of gives the title of a camera (names.Names.title). A stored story
    keeps its words."""

    def __init__(self, frigate, pet_days, summarizer, chat, gpu_check, store_path, pet, clock,
                 title_of=alerts.camera_name):
        self.frigate = frigate
        self.title_of = title_of
        self.pet_days = pet_days
        self.summarizer = summarizer
        self.chat = chat
        self.gpu_check = gpu_check
        self.path = store_path
        self.pet = pet
        self.clock = clock
        state = jsonstore.load(store_path, {})
        state = state if isinstance(state, dict) else {}
        self.stories = state.get("stories", {})
        self._meta = state.get("meta", {})

    def _save(self):
        jsonstore.save(self.path, {"stories": self.stories, "meta": self._meta})

    def story(self, date):
        return self.stories.get(date)

    def meta(self, date):
        return self._meta.get(date, {})

    # --- one story ----------------------------------------------------------

    def _gather(self, date):
        start, end = pet_day.day_bounds(date)
        end = min(end, self.clock())
        reviews = self.frigate.reviews(after=start, before=end, limit=5000)
        items = pet_items(reviews, self.pet, start, end)
        sums = self.summarizer.summaries(start - 1)
        return start, end, items, sums

    def _ask(self, messages):
        body = {"model": MODEL, "stream": False, "format": "json", "keep_alive": "2m",
                # The same num_ctx as the summaries: a different one makes Ollama
                # reload the model (83 s, measured). num_predict caps the
                # answer: in JSON mode the model can pad with whitespace until
                # the context is full, and one call ran past 10 minutes.
                "options": {"temperature": 0.4, "num_ctx": summaries.NUM_CTX,
                            "num_predict": STORY_MAX_TOKENS}, "messages": messages}
        return self.chat(body)

    def write(self, date, final, use_model):
        """Make the day data fresh, then write, check, and keep the story.
        Returns the story, or None (no pet that day, or Ollama failed for a
        story that is not final)."""
        started = time.monotonic()
        start, end, items, sums = self._gather(date)
        meta = {"at": self.clock(), "summaries": sum(1 for r in items if r["id"] in sums),
                "final": final}
        if not items:
            self._meta[date] = dict(meta, how="none")
            self._save()
            return None
        self.pet_days.make(date)
        day = self.pet_days.day(date) or {}
        moments_by_review = {m["review"]: m["t"] for m in day.get("moments", [])}
        events = self.frigate.events(after=start - 600, before=end, cameras=[self.pet.camera],
                                     limit=5000)
        others = [e for e in events if e.get("label") == self.pet.other_animal]
        items_by_id = {r["id"]: r for r in items}
        episodes, runs = build_episodes(items, sums, self.pet)
        now = self.clock()
        story, how, errors = None, "template", []
        if use_model and episodes:
            camera_title = self.title_of(self.pet.camera)
            system, user = build_prompt(date, episodes, final, self.pet, camera_title)
            messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
            try:
                for attempt in ("first", "retry"):
                    content = self._ask(messages)
                    answer = parse_answer(content, self.pet, camera_title)
                    errors = check(answer, episodes, others, self.pet, camera_title)
                    log.info("story %s, %s answer: %s", date, attempt,
                             "passes" if not errors else "; ".join(errors))
                    if not errors:
                        story = assemble(answer, episodes, runs, items_by_id, moments_by_review,
                                         events, self.pet, final, now)
                        how = attempt
                        break
                    messages = messages + [
                        {"role": "assistant", "content": content},
                        {"role": "user", "content": "Your answer broke these rules:\n- "
                         + "\n- ".join(errors)
                         + "\nWrite the whole answer again as JSON, keeping every rule."}]
            except Exception as exc:
                log.warning("story %s: Ollama call failed: %s", date, type(exc).__name__)
                if not final:
                    self._meta[date] = dict(self.meta(date), at=meta["at"])
                    self._save()
                    return None
        if story is None:
            story = template(episodes, runs, items_by_id, moments_by_review, events, self.pet,
                             final, now)
        self.stories[date] = story
        self._meta[date] = dict(meta, how=how, errors=errors,
                                seconds=round(time.monotonic() - started, 1))
        self._save()
        log.info("story %s (%s, %s) in %.1f s: %s", date, "final" if final else "so far", how,
                 time.monotonic() - started, story["title"])
        return story

    # --- the schedule -------------------------------------------------------

    def step(self):
        now = self.clock()
        lt = time.localtime(now)
        today = time.strftime("%Y-%m-%d", lt)
        yesterday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
        hm = (lt.tm_hour, lt.tm_min)

        if hm >= FINAL_FROM and not self.meta(yesterday).get("final"):
            y_start, y_end = pet_day.day_bounds(yesterday)
            late = hm >= FINAL_BY
            free = self.gpu_check()
            if late or (free and self.summarizer.backlog(y_start, y_end) == 0):
                self.write(yesterday, final=True, use_model=free)
                self._meta.setdefault(yesterday, {})["final"] = True
                self._save()

        # A final story that fell back to the template (GPU busy at 06:00) gets
        # one try with the model the first time the GPU is free that day.
        y = self.meta(yesterday)
        if (hm >= FINAL_FROM and y.get("final") and y.get("how") == "template"
                and not y.get("retried")):
            y_start, y_end = pet_day.day_bounds(yesterday)
            if self.gpu_check() and self.summarizer.backlog(y_start, y_end) == 0:
                self.write(yesterday, final=True, use_model=True)
                self._meta.setdefault(yesterday, {}).update(final=True, retried=True)
                self._save()

        last = self.meta(today)
        if last.get("at") is not None and now - last["at"] < EVERY_S:
            return
        if self.summarizer.backlog() != 0 or not self.gpu_check():
            return
        start, end, items, sums = self._gather(today)
        count = sum(1 for r in items if r["id"] in sums)
        if count - last.get("summaries", 0) >= NEW_SUMMARIES:
            self.write(today, final=False, use_model=True)

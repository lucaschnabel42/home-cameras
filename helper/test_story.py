"""Tests for story.py. Run: python -m pytest -q helper"""

import json
import time

import pytest

import pet
import story as st

PET = pet.Pet("Rex", "living_room_cam")

DATE = "2027-01-15"


def at(hh, mm=0, ss=0, day=15):
    return time.mktime((2027, 1, day, hh, mm, ss, 0, 0, -1))


def review(rid, start, end=None, objects=("dog",), audio=(), cam="living_room_cam"):
    return {"id": rid, "camera": cam, "start_time": start,
            "end_time": start + 60 if end is None else end,
            "data": {"objects": list(objects), "audio": list(audio), "detections": []}}


def s(title, text=""):
    return {"title": title, "summary": text}


# --- episodes ---------------------------------------------------------------------

def test_only_dog_or_bark_items_on_the_camera_reach_the_story():
    reviews = [review("dog", at(9)), review("bark", at(9, 5), objects=[], audio=["bark"]),
               review("howl", at(9, 6), objects=["person"], audio=["howl"]),
               review("person", at(9, 10), objects=["person"]),
               review("porch", at(9, 20), cam="front_porch_cam"),
               review("yesterday", at(23, day=14))]
    items = st.pet_items(reviews, PET, at(0), at(0, day=16))
    assert [r["id"] for r in items] == ["dog", "bark", "howl"]


def test_episodes_group_one_kind_under_20_min_apart():
    items = [review("a", at(9, 0)), review("b", at(9, 10)), review("c", at(9, 35)),
             review("d", at(9, 40)), review("e", at(9, 45))]
    sums = {"a": s("Rex naps on the couch"), "b": s("Rex naps on the couch"),
            "c": s("Rex naps on the couch"),  # 34 min after b ended: a new episode
            "d": s("Rex walks across the room"), "e": s("Rex naps on the couch")}
    eps, runs = st.build_episodes(items, sums, PET)
    assert [(e["id"], e["kind"], e["items"]) for e in eps] == [
        ("e1", "nap", ["a", "b"]), ("e2", "nap", ["c"]), ("e3", "walk", ["d"]),
        ("e4", "nap", ["e"])]
    assert runs == []
    assert eps[0]["start"] == at(9, 0) and eps[0]["end"] == at(9, 11)


def test_rare_kinds_are_must():
    items = [review("a", at(9)), review("b", at(10)), review("c", at(11)),
             review("d", at(12), objects=[], audio=["bark"])]
    sums = {"a": s("Rex plays with ball", "Rex chases a ball."),
            "b": s("Rex rests", "A person pets Rex on the couch."),
            "c": s("Rex naps on the couch"), "d": s("Rex barks", "Rex barks.")}
    eps, _ = st.build_episodes(items, sums, PET)
    assert [(e["kind"], e["must"]) for e in eps] == [
        ("play", True), ("with-person", True), ("nap", False), ("bark", True)]


def test_items_without_a_summary_make_runs_and_break_episodes():
    items = [review("a", at(9, 0)), review("x", at(9, 5)), review("y", at(9, 6)),
             review("b", at(9, 10))]
    sums = {"a": s("Rex naps on the couch"), "b": s("Rex naps on the couch")}
    eps, runs = st.build_episodes(items, sums, PET)
    assert [e["items"] for e in eps] == [["a"], ["b"]]
    assert runs == [{"start": at(9, 5), "end": at(9, 7), "items": ["x", "y"]}]


def test_notes_are_distinct_cleaned_and_at_most_three():
    items = [review(str(i), at(9, i)) for i in range(6)]
    texts = ["Rex, the dog, lies on the couch.", "Rex, the dog, lies on the couch.",
             "The dog, Rex, is curled up.", "Rex naps.", "A black dog sleeps.",
             "Rex rests under a blanket."]
    sums = {str(i): s("Rex naps on the couch", t) for i, t in enumerate(texts)}
    (ep,), _ = st.build_episodes(items, sums, PET)
    assert len(ep["notes"]) == 3
    assert ep["notes"][0] == "Rex lies on the couch."
    assert ep["notes"][-1] == "Rex rests under a blanket."
    assert not any("dog" in n.lower() for n in ep["notes"])


def test_a_clipped_note_ends_at_its_last_full_sentence():
    assert st.clean_note("Rex lies down. He then turns and the scene remains…", PET) == \
        "Rex lies down."


def test_part_of_day():
    assert [st.part_of_day(at(h)) for h in (3, 8, 13, 18, 22)] == \
        ["night", "morning", "afternoon", "evening", "night"]


# --- the prompt -------------------------------------------------------------------

def test_prompt_lists_episodes_without_clock_times():
    items = [review("a", at(9, 0)), review("b", at(16, 11))]
    sums = {"a": s("Rex naps on the couch", "Rex is curled up on the couch."),
            "b": s("Rex plays with ball", "Rex chases a ball thrown by a person.")}
    eps, _ = st.build_episodes(items, sums, PET)
    system, user = st.build_prompt(DATE, eps, final=False, pet=PET)
    assert "Rex" in system and "JSON" in system
    assert "so far" in user and "Friday" in user
    listed = json.loads(user[user.index("["):])
    assert listed == [
        {"id": "e1", "part": "morning", "kind": "nap",
         "notes": ["Rex is curled up on the couch."]},
        {"id": "e2", "part": "afternoon", "kind": "play", "must": True,
         "notes": ["Rex chases a ball thrown by a person."]}]
    assert not any(ch.isdigit() for ch in user.replace("e1", "").replace("e2", ""))


# --- the checker: one failing story per rule --------------------------------------

def day():
    """A morning nap, an afternoon game of ball (must), an evening walk."""
    items = [review("a", at(9, 0)), review("b", at(15, 0)), review("c", at(19, 0))]
    sums = {"a": s("Rex naps on the couch", "Rex is curled up under a blanket on the couch."),
            "b": s("Rex plays with ball", "Rex chases a ball thrown by a person."),
            "c": s("Rex walks around", "Rex walks from the kitchen to the door.")}
    eps, _ = st.build_episodes(items, sums, PET)
    return eps


GOOD = {"title": "A nap, a ball and a walk",
        "chapters": [
            {"episodes": ["e1"], "text": "In the morning Rex curled up on the couch under a "
                                         "blanket."},
            {"episodes": ["e2"], "text": "Later someone threw a ball and he ran after it."},
            {"episodes": ["e3"], "text": "In the evening he walked from the kitchen to the "
                                         "door."}]}


def with_text(i, text, title=None):
    answer = json.loads(json.dumps(GOOD))
    if text is not None:
        answer["chapters"][i]["text"] = text
    if title is not None:
        answer["title"] = title
    return answer


def errors(answer, cats=()):
    return st.check(answer, day(), list(cats), PET)


def test_good_story_passes():
    assert errors(GOOD) == []


@pytest.mark.parametrize("answer", [
    None, [], {"title": "", "chapters": GOOD["chapters"]}, {"title": "x", "chapters": []},
    {"title": "x" * 61, "chapters": GOOD["chapters"]},
    {"title": "x", "chapters": [{"episodes": [], "text": "He slept."}]},
    {"title": "x", "chapters": [{"episodes": ["e1"], "text": ""}]},
    {"title": "x", "chapters": [{"episodes": ["e1"], "text": "He slept."}] * 7},
])
def test_rule_shape(answer):
    assert errors(answer)


def test_rule_one_to_three_sentences():
    assert errors(with_text(0, "Rex slept. He slept. He slept on. He curled up."))


def test_rule_unknown_episode():
    answer = with_text(0, None)
    answer["chapters"][0]["episodes"] = ["e1", "e9"]
    assert any("e9" in e for e in errors(answer))


def test_rule_episode_in_two_chapters():
    answer = with_text(0, None)
    answer["chapters"][2]["episodes"] = ["e3", "e1"]
    assert any("e1" in e for e in errors(answer))


def test_rule_must_episode_used():
    answer = with_text(0, None)
    del answer["chapters"][1]
    assert any("e2" in e for e in errors(answer))


@pytest.mark.parametrize("text", ["In the morning Rex napped 3 times.",
                                  "In the morning Rex napped two times.",
                                  "In the morning Rex napped twice.",
                                  "In the morning Rex took his third nap."])
def test_rule_no_numbers(text):
    assert errors(with_text(0, text))


def test_rule_no_number_in_the_title():
    assert errors(with_text(0, None, title="Four naps and one ball"))


@pytest.mark.parametrize("word", ["she", "her", "hers", "herself", "She"])
def test_rule_no_she(word):
    assert errors(with_text(0, f"In the morning {word} curled up on the couch."))


def test_rule_no_the_dog():
    assert errors(with_text(0, "In the morning the dog curled up on the couch."))


def test_rule_capitals_only_from_the_allowlist():
    assert errors(with_text(0, "In the morning Rex watched Netflix on the couch."))
    assert errors(with_text(0, None, title="Rex and Sam"))
    assert errors(with_text(0, "On Friday morning Rex curled up on the couch.")) == []


@pytest.mark.parametrize("word", ["man", "woman", "mom", "dad", "owner", "husband", "wife",
                                  "boyfriend", "girlfriend", "Mom"])
def test_rule_no_person_words(word):
    assert errors(with_text(1, f"Later his {word} threw a ball and he ran after it."))


def test_rule_object_must_be_in_the_chapters_own_notes():
    # "ball" is in e2's notes, not in e1's.
    assert errors(with_text(0, "In the morning Rex curled up on the couch with a ball."))
    assert errors(with_text(0, "In the morning Rex curled up on the couch with treats."))
    assert errors(with_text(0, None, title="A day of shoes"))


def test_rule_cat_needs_a_frigate_cat_label_near_the_chapter():
    eps = day()
    eps[0]["notes"].append("A cat sits on the couch.")
    answer = with_text(0, "In the morning Rex curled up on the couch beside a cat.")
    assert st.check(answer, eps, [], PET)
    near = {"label": "cat", "start_time": at(9, 4), "end_time": at(9, 5)}
    far = {"label": "cat", "start_time": at(9, 30), "end_time": at(9, 31)}
    assert st.check(answer, eps, [far], PET)
    assert st.check(answer, eps, [near], PET) == []


@pytest.mark.parametrize("verb", ["thinks", "dreamed", "wanted", "hoped", "wishes", "decided",
                                  "plans"])
def test_rule_no_thought_verbs(verb):
    assert errors(with_text(0, f"In the morning Rex {verb} about the couch."))


def test_rule_no_two_chapters_start_with_the_same_three_words():
    answer = with_text(0, "Later someone threw nothing, and Rex curled up on the couch "
                          "under a blanket.")
    assert errors(answer) == ['chapter 2: starts with the same words as chapter 1 '
                              '("later someone threw").']


def test_rule_no_trigram_more_than_twice():
    answer = with_text(0, "In the morning he curled up on the couch. He curled up on the "
                          "blanket. He curled up again.")
    assert errors(answer)


def test_rule_place_phrases_may_repeat():
    # 2026-10-17: a napping dog is "on the couch" in most sentences; only that
    # kind of phrase is exempt from the repeat rule
    answer = with_text(0, "In the morning Rex curled up on the couch under a blanket. He "
                          "stayed on the couch. He slept on the couch.")
    assert errors(answer) == []


def test_rule_part_of_day_matches_the_chapter():
    assert errors(with_text(0, "In the evening Rex curled up on the couch."))
    assert errors(with_text(2, "At night he walked from the kitchen to the door."))
    assert errors(with_text(1, "At lunchtime someone threw a ball and he ran after it."))
    assert errors(with_text(1, "In the afternoon someone threw a ball and he ran after it.")) == []


# --- the story --------------------------------------------------------------------

class FakeChat:
    def __init__(self, answers):
        self.answers = list(answers)
        self.bodies = []

    def __call__(self, body):
        self.bodies.append(json.loads(json.dumps(body)))
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a if isinstance(a, str) else json.dumps(a)


class FakeFrigate:
    def __init__(self, reviews, events=()):
        self.rv = reviews
        self.ev = list(events)

    def reviews(self, after=None, before=None, **kw):
        return [r for r in self.rv if after <= r["start_time"] < before]

    def events(self, after=None, before=None, **kw):
        return [e for e in self.ev if after <= e["start_time"] < before]


class FakeSummarizer:
    def __init__(self, sums, backlog=0):
        self.sums = sums
        self.waiting = backlog

    def summaries(self, after):
        return self.sums

    def backlog(self, after=None, before=None):
        return self.waiting


class FakePetDay:
    def __init__(self, moments=()):
        self.made = []
        self.moments = list(moments)

    def make(self, date):
        self.made.append(date)

    def day(self, date):
        return {"moments": self.moments}


def writer(tmp_path, reviews, sums, answers, events=(), free=True, backlog=0, moments=(),
           clock=None):
    t = {"now": clock or at(20, 30)}
    w = st.StoryWriter(FakeFrigate(reviews, events), FakePetDay(moments),
                       FakeSummarizer(sums, backlog), FakeChat(answers), lambda: free,
                       str(tmp_path / "stories.json"), PET, clock=lambda: t["now"])
    return w, t


def day_reviews():
    reviews = [review("a", at(9, 0)), review("b", at(15, 0)), review("c", at(19, 0)),
               review("x", at(20, 0), objects=[], audio=["bark"]), review("y", at(20, 5))]
    sums = {"a": s("Rex naps on the couch", "Rex is curled up under a blanket on the couch."),
            "b": s("Rex plays with ball", "Rex chases a ball thrown by a person."),
            "c": s("Rex walks around", "Rex walks from the kitchen to the door.")}
    events = [{"id": f"k{i}", "label": "bark", "camera": "living_room_cam",
               "start_time": at(20, 0, 0) + i * 70, "end_time": at(20, 0, 0) + i * 70 + 61}
              for i in range(3)]
    moments = [{"t": at(9, 0, 30), "review": "a"}, {"t": at(15, 0, 20), "review": "b"},
               {"t": at(20, 5, 10), "review": "y"}]
    return reviews, sums, events, moments


def test_story_from_a_good_answer(tmp_path):
    reviews, sums, events, moments = day_reviews()
    w, t = writer(tmp_path, reviews, sums, [GOOD], events=events, moments=moments)
    story = w.write(DATE, final=False, use_model=True)
    assert story["title"] == GOOD["title"] and story["final"] is False
    assert story["written"] == int(t["now"])
    assert [c["code"] for c in story["chapters"]] == [False, False, False, True]
    first = story["chapters"][0]
    assert first == {"start": at(9, 0), "end": at(9, 1), "text": GOOD["chapters"][0]["text"],
                     "moments": [at(9, 0, 30)], "code": False}
    code = story["chapters"][3]
    assert code["start"] == at(20, 0) and code["moments"] == [at(20, 5, 10)]
    assert code["text"] == ("The camera heard Rex bark 3 times. Tap to listen. "
                            "Rex was on camera once; that moment has no description yet.")
    assert w.story(DATE) == story
    body = w.chat.bodies[0]
    assert body["model"] == "qwen2.5vl:7b" and body["format"] == "json"
    assert body["keep_alive"] == "2m" and body["stream"] is False
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_one_retry_with_the_errors(tmp_path):
    reviews, sums, events, moments = day_reviews()
    bad = with_text(0, "In the morning the dog curled up on the couch.")
    w, _ = writer(tmp_path, reviews, sums, [bad, GOOD], events=events, moments=moments)
    story = w.write(DATE, final=False, use_model=True)
    assert story["title"] == GOOD["title"]
    retry = w.chat.bodies[1]["messages"]
    assert [m["role"] for m in retry] == ["system", "user", "assistant", "user"]
    assert "the dog" in retry[3]["content"]
    assert w.meta(DATE)["how"] == "retry"


def test_template_after_two_failures(tmp_path):
    reviews, sums, events, moments = day_reviews()
    bad = with_text(0, "In the morning the dog curled up on the couch.")
    w, _ = writer(tmp_path, reviews, sums, [bad, "not json"], events=events, moments=moments)
    story = w.write(DATE, final=True, use_model=True)
    assert len(w.chat.bodies) == 2
    assert story["final"] is True and story["title"] == "Rex's day"
    assert all(c["code"] for c in story["chapters"])
    texts = [c["text"] for c in story["chapters"]]
    assert texts[0] == "In the morning Rex napped."
    assert texts[1] == "In the afternoon Rex played."
    assert texts[2] == "In the evening Rex walked around the room."
    assert "bark 3 times" in texts[3]
    assert w.meta(DATE)["how"] == "template"


def test_template_says_so_far_for_today():
    eps = day()
    story = st.template(eps, [], {}, {}, [], PET, final=False, now=at(20))
    assert story["title"] == "Rex's day so far"


def test_template_of_one_part_lists_its_kinds_in_order():
    items = [review("a", at(13)), review("b", at(14)), review("c", at(15)), review("d", at(16))]
    sums = {"a": s("Rex naps on the couch"), "b": s("Rex walks around"),
            "c": s("Rex naps on the couch"), "d": s("Rex rests", "A person pets Rex.")}
    eps, _ = st.build_episodes(items, sums, PET)
    story = st.template(eps, [], {}, {}, [], pet.Pet("Rex", "c"), final=True, now=at(20))
    assert [c["text"] for c in story["chapters"]] == [
        "In the afternoon Rex napped, walked around the room and spent time with someone."]


def test_no_rex_no_story(tmp_path):
    w, _ = writer(tmp_path, [review("p", at(9), objects=["person"])], {}, [])
    assert w.write(DATE, final=True, use_model=True) is None
    assert w.story(DATE) is None


def test_ollama_down_writes_nothing_for_today_but_the_final_falls_back(tmp_path):
    reviews, sums, events, moments = day_reviews()
    w, _ = writer(tmp_path, reviews, sums, [OSError("refused"), OSError("refused")],
                  events=events, moments=moments)
    assert w.write(DATE, final=False, use_model=True) is None
    assert w.story(DATE) is None
    story = w.write(DATE, final=True, use_model=True)
    assert story["title"] == "Rex's day" and all(c["code"] for c in story["chapters"])


# --- the schedule ------------------------------------------------------------------

def many(n, hour=9):
    reviews = [review(f"r{i}", at(hour, i * 2)) for i in range(n)]
    sums = {f"r{i}": s("Rex naps on the couch", "Rex is curled up on the couch.")
            for i in range(n)}
    return reviews, sums


NAP = {"title": "A long nap", "chapters": [{"episodes": ["e1"],
                                            "text": "Rex curled up on the couch."}]}


def test_today_needs_three_new_summaries_a_free_gpu_and_no_backlog(tmp_path):
    reviews, sums = many(2)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(10))
    w.step()
    assert w.story(DATE) is None  # two summaries only
    reviews, sums = many(3)
    w.frigate.rv, w.summarizer.sums = reviews, sums
    w.summarizer.waiting = 1
    w.step()
    assert w.story(DATE) is None  # a summary is waiting
    w.summarizer.waiting = 0
    w.gpu_check = lambda: False
    w.step()
    assert w.story(DATE) is None  # the GPU is busy
    w.gpu_check = lambda: True
    w.step()
    assert w.story(DATE)["final"] is False
    assert w.pet_days.made == ["2027-01-15"]  # the day data is made fresh first


def test_today_at_most_once_an_hour_and_only_with_three_more(tmp_path):
    reviews, sums = many(3)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(10))
    w.step()
    assert len(w.chat.bodies) == 1
    reviews, sums = many(6)
    w.frigate.rv, w.summarizer.sums = reviews, sums
    t["now"] = at(10, 59)
    w.step()
    assert len(w.chat.bodies) == 1  # not yet an hour
    t["now"] = at(11, 0)
    w.step()
    assert len(w.chat.bodies) == 2
    reviews, sums = many(8)
    w.frigate.rv, w.summarizer.sums = reviews, sums
    t["now"] = at(12, 30)
    w.step()
    assert len(w.chat.bodies) == 2  # only two more summaries


def test_final_for_yesterday_after_00_10_when_its_summaries_are_done(tmp_path):
    reviews, sums = many(3, hour=9)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(0, 5, day=16))
    w.summarizer.waiting = 0
    w.step()
    assert w.story(DATE) is None  # before 00:10
    t["now"] = at(0, 10, day=16)
    w.summarizer.waiting = 2
    w.step()
    assert w.story(DATE) is None  # its summaries are not done
    w.summarizer.waiting = 0
    w.step()
    assert w.story(DATE)["final"] is True and w.meta(DATE)["how"] == "first"
    assert "2027-01-15" in w.pet_days.made
    t["now"] = at(0, 30, day=16)
    w.step()
    assert len(w.chat.bodies) == 1  # never rewritten


def test_final_at_06_00_at_the_latest_even_with_a_busy_gpu(tmp_path):
    reviews, sums = many(3, hour=9)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(5, 59, day=16), free=False,
                  backlog=4)
    w.step()
    assert w.story(DATE) is None
    t["now"] = at(6, 0, day=16)
    w.step()
    story = w.story(DATE)
    assert story["final"] is True and all(c["code"] for c in story["chapters"])
    assert w.chat.bodies == []


def test_final_survives_a_restart(tmp_path):
    reviews, sums = many(3, hour=9)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(7, 0, day=16))
    w.step()
    assert w.story(DATE)["final"] is True
    again, _ = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(8, 0, day=16))
    again.step()
    assert again.story(DATE)["final"] is True
    assert again.chat.bodies == []
    assert "2027-01-15" not in again.pet_days.made


def test_a_template_final_gets_one_model_try_when_the_gpu_frees(tmp_path):
    reviews, sums = many(3, hour=9)
    w, t = writer(tmp_path, reviews, sums, [NAP] * 5, clock=at(6, 0, day=16), free=False,
                  backlog=4)
    w.step()
    assert all(c["code"] for c in w.story(DATE)["chapters"])  # busy at 06:00: the template
    w.gpu_check = lambda: True
    w.summarizer.waiting = 0
    t["now"] = at(9, 0, day=16)
    w.step()
    story = w.story(DATE)
    assert story["final"] is True and not all(c["code"] for c in story["chapters"])
    assert len(w.chat.bodies) == 1
    t["now"] = at(11, 0, day=16)
    w.step()
    assert len(w.chat.bodies) == 1  # one try, then never again


def test_notes_drop_filler_sentences():
    assert st.clean_note("Rex lies on the couch. The scene remains unchanged across the three "
                         "frames. A person is not visible in these frames.", PET) == \
        "Rex lies on the couch."
    assert st.clean_note("The scene remains unchanged.", PET) == "The scene remains unchanged."


def test_notes_prefer_ones_that_name_an_object():
    items = [review(str(i), at(9, i)) for i in range(6)]
    texts = ["Rex lies on the couch.", "Rex is curled up.", "Rex naps.",
             "Rex sleeps under a blanket.", "Rex rests.", "Rex dozes."]
    sums = {str(i): s("Rex naps on the couch", t) for i, t in enumerate(texts)}
    (ep,), _ = st.build_episodes(items, sums, PET)
    assert len(ep["notes"]) == 3
    assert "Rex sleeps under a blanket." in ep["notes"]
    assert ep["notes"] == sorted(ep["notes"], key=texts.index)  # still in time order


def test_a_title_case_title_is_made_a_sentence_before_the_check():
    # 2026-10-17: the model wrote "A Quiet Day Stroll", and the capitals rule
    # rejected it twice; sentence case is a formatting choice, not an error
    answer = st.parse_answer(json.dumps(dict(GOOD, title="A Quiet Day Stroll")), PET)
    assert answer["title"] == "A quiet day stroll"
    assert errors(answer) == []


def test_a_partly_title_case_title_keeps_only_allowed_capitals():
    answer = st.parse_answer(json.dumps(dict(GOOD, title="Rex's Day of Rest on Friday")), PET)
    assert answer["title"] == "Rex's day of rest on Friday"
    assert errors(answer) == []
    assert st.title_sentence("Rex Has A Nap By The TV", PET) == "Rex has a nap by the TV"


def test_story_calls_cap_the_answer_and_share_the_summaries_context(tmp_path):
    reviews, sums, events, moments = day_reviews()
    w, _ = writer(tmp_path, reviews, sums, [NAP],
                  events=events, moments=moments)
    w.write(DATE, final=False, use_model=True)
    opts = w.chat.bodies[0]["options"]
    import summaries
    assert opts["num_ctx"] == summaries.NUM_CTX and 0 < opts["num_predict"] <= 1000


# --- another pet ----------------------------------------------------------------------

MISO = pet.Pet("Miso", "kitchen_cam", "cat", "female")


def test_the_prompt_names_the_pet_of_the_settings():
    system = st.system_prompt(MISO)
    assert "Miso, a female cat" in system and "the kitchen camera" in system
    assert '"she"' in system and '"the cat"' in system and '"he", "him", "his"' in system
    assert "{" not in system.split("Answer with JSON")[0]


def test_the_checker_uses_the_pronouns_and_animal_of_the_pet():
    eps = [{"id": "e1", "kind": "nap", "must": False, "start": at(9), "end": at(9, 5),
            "items": ["a"], "spans": [(at(9), at(9, 5))], "notes": ["Miso naps on the couch."]}]
    good = {"title": "Miso naps", "chapters": [{"episodes": ["e1"], "text": "Miso naps. She is curled up."}]}
    assert st.check(good, eps, [], MISO) == []
    bad = {"title": "Miso naps", "chapters": [{"episodes": ["e1"], "text": "Miso naps. He sees a dog."}]}
    errors = st.check(bad, eps, [], MISO)
    assert any('"he"' in e for e in errors)
    assert any("dog" in e for e in errors)


def test_clean_note_names_a_cat():
    assert st.clean_note("The grey cat sits by the window.", MISO) == "Miso sits by the window."

"""Tests for summaries.py. Run: python -m pytest -q helper"""

import base64
import json

import pytest

import pet
import summaries
from summaries import Summarizer, build_prompt, gpu_free, parse_answer

PET = pet.Pet("Rex", "living_room_cam")

MIB = 1024 * 1024
NOW = 1_800_000_000.0


# --- the GPU gate -------------------------------------------------------------

def gate(smi, ps=None):
    def run(argv):
        assert argv[0] == "nvidia-smi" and "--query-gpu=memory.used" in argv
        if isinstance(smi, Exception):
            raise smi
        return smi

    def get_ps():
        if isinstance(ps, Exception):
            raise ps
        return {"models": ps or []}

    return gpu_free(run, get_ps)


def ours(vram_mib):
    return {"name": "qwen2.5vl:7b", "model": "qwen2.5vl:7b", "size_vram": vram_mib * MIB}


def test_gate_free_when_little_memory_used():
    assert gate("755\n") is True


def test_gate_busy_at_2500_mib():
    assert gate("2499") is True
    assert gate("2500") is False


def test_gate_free_when_the_rest_is_our_model():
    assert gate("8100\n", [ours(5800)]) is True


def test_gate_counts_ollamas_overhead_beside_our_model():
    """Measured 2026-10-16: 755 MiB before, 7463 MiB with qwen2.5vl loaded
    (size_vram 5233 MiB). The 1475 MiB beyond size_vram is Ollama's."""
    assert gate("7463", [ours(5233)]) is True
    # A desktop at 1500 MiB is still free with our model loaded.
    assert gate(str(1500 + 5233 + 1475), [ours(5233)]) is True
    # Another program with 2000 MiB beside our model: busy.
    assert gate(str(755 + 5233 + 1475 + 2000), [ours(5233)]) is False


def test_gate_busy_when_something_else_is_loaded_beside_ours():
    assert gate("15000\n", [ours(5800)]) is False
    other = {"name": "llama3.1:8b", "model": "llama3.1:8b", "size_vram": 5000 * MIB}
    assert gate("8100", [other]) is False


def test_gate_sums_every_gpu():
    assert gate("1500\n1500\n") is False


@pytest.mark.parametrize("smi", [OSError("no nvidia-smi"), "", "N/A\n", "[Not Supported]"])
def test_gate_busy_when_memory_unknown(smi):
    assert gate(smi) is False


def test_gate_ignores_a_broken_ollama_ps():
    assert gate("755", OSError("down")) is True
    assert gate("8100", OSError("down")) is False


# --- prompt and answer ------------------------------------------------------------

def test_prompt_names_the_pet_and_the_camera():
    review = {"camera": "living_room_cam", "start_time": NOW, "end_time": NOW + 95,
              "data": {"objects": ["dog", "person"], "audio": ["bark"]}}
    text = build_prompt(review, frames=3, pet=PET)
    assert "Rex (the dog)" in text and '"he"' in text and "Rex barking" in text
    assert "Living room" in text and "3 frames" in text
    assert "title" in text and "summary" in text


def test_prompt_without_a_pet_uses_plain_words():
    review = {"camera": "living_room_cam", "start_time": NOW, "end_time": NOW + 95,
              "data": {"objects": ["dog", "person"], "audio": ["bark"]}}
    text = build_prompt(review, frames=3)
    assert "a dog" in text and "a dog barking" in text and "Rex" not in text
    assert "Do not guess names of people or animals" in text


def test_a_cat_pet_takes_the_name_and_a_bark_stays_a_dog():
    miso = pet.Pet("Miso", "kitchen_cam", "cat", "female")
    review = {"camera": "kitchen_cam", "start_time": NOW, "end_time": NOW + 95,
              "data": {"objects": ["cat"], "audio": ["bark"]}}
    text = build_prompt(review, frames=3, pet=miso)
    assert "Miso (the cat)" in text and '"she"' in text and "a dog barking" in text


def test_parse_good_answer():
    got = parse_answer(json.dumps({"title": "Rex naps on the couch",
                                   "summary": "Rex sleeps on the green couch the whole time."}))
    assert got == {"title": "Rex naps on the couch",
                   "summary": "Rex sleeps on the green couch the whole time."}


def test_parse_clips_long_fields_on_a_word():
    got = parse_answer(json.dumps({"title": "word " * 30, "summary": "longer words " * 40}))
    assert len(got["title"]) <= 60 and len(got["summary"]) <= 200
    assert got["title"].endswith("…") and not got["title"][:-1].endswith(" ")
    assert got["summary"].endswith("…")


def test_parse_squeezes_whitespace():
    got = parse_answer('{"title": "  Rex\\n at  the door ", "summary": "He waits."}')
    assert got == {"title": "Rex at the door", "summary": "He waits."}


@pytest.mark.parametrize("content", [
    "", "not json", "[]", '{"title": "x"}', '{"title": "", "summary": "y"}',
    '{"title": 5, "summary": "y"}', '{"title": "x", "summary": null}'])
def test_parse_bad_answers(content):
    assert parse_answer(content) is None


# --- the worker -------------------------------------------------------------------

def review(id, start, end, cam="living_room_cam"):
    return {"id": id, "camera": cam, "start_time": start, "end_time": end,
            "data": {"objects": ["dog"], "audio": []}}


class FakeFrigate:
    def __init__(self, reviews, missing=()):
        self.rv = reviews
        self.missing = set(missing)
        self.snaps = []

    def reviews(self, after=None, **kw):
        return [r for r in self.rv if r["start_time"] >= after]

    def snapshot(self, camera, t, height):
        self.snaps.append((camera, t, height))
        if camera in self.missing:
            raise OSError("404")
        return b"\xff\xd8jpeg" + str(t).encode()


class FakeChat:
    def __init__(self, answers):
        self.answers = list(answers)
        self.bodies = []

    def __call__(self, body):
        self.bodies.append(body)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


GOOD = json.dumps({"title": "Rex at the door", "summary": "He waits by the door."})


def make(tmp_path, reviews, answers, free=True, clock=None, missing=()):
    t = {"now": NOW}
    frig, chat = FakeFrigate(reviews, missing), FakeChat(answers)
    s = Summarizer(frig, chat, lambda: free, str(tmp_path / "summaries.json"),
                   clock=clock or (lambda: t["now"]), pet=PET)
    return s, frig, chat, t


def test_newest_first_three_frames_one_call(tmp_path):
    reviews = [review("old", NOW - 4000, NOW - 3900), review("new", NOW - 1000, NOW - 900)]
    s, frig, chat, _ = make(tmp_path, reviews, [GOOD])
    s.step()
    assert len(chat.bodies) == 1
    body = chat.bodies[0]
    assert body["model"] == "qwen2.5vl:7b" and body["format"] == "json"
    assert body["keep_alive"] == "2m" and body["stream"] is False
    msg = body["messages"][0]
    assert "Rex" in msg["content"] and len(msg["images"]) == 3
    assert base64.b64decode(msg["images"][0]).startswith(b"\xff\xd8")
    assert [t for _, t, _ in frig.snaps] == [NOW - 998, NOW - 950, NOW - 902]
    assert all(h == 480 for _, _, h in frig.snaps)
    assert s.summaries(0) == {"new": {"title": "Rex at the door",
                                      "summary": "He waits by the door."}}


def test_waits_while_gpu_busy(tmp_path):
    s, frig, chat, _ = make(tmp_path, [review("a", NOW - 1000, NOW - 900)], [GOOD], free=False)
    s.step()
    assert chat.bodies == [] and frig.snaps == []


def test_skips_items_still_open_or_just_ended(tmp_path):
    reviews = [review("open", NOW - 100, None), review("fresh", NOW - 100, NOW - 10)]
    s, frig, chat, _ = make(tmp_path, reviews, [])
    s.step()
    assert chat.bodies == []


def test_only_the_last_48_h(tmp_path):
    s, frig, chat, _ = make(tmp_path, [review("a", NOW - 49 * 3600, NOW - 49 * 3600 + 60)], [])
    s.step()
    assert chat.bodies == []


def test_at_most_three_per_minute(tmp_path):
    reviews = [review(str(i), NOW - 1000 - i * 100, NOW - 950 - i * 100) for i in range(10)]
    s, frig, chat, t = make(tmp_path, reviews, [GOOD] * 10)
    for i in range(12):
        t["now"] = NOW + i * 5  # 12 steps in one minute
        s.step()
    assert len(chat.bodies) == 3


def test_bad_answer_retried_once_later_then_skipped(tmp_path):
    s, frig, chat, t = make(tmp_path, [review("a", NOW - 1000, NOW - 900)],
                            ["nonsense", "still nonsense"])
    s.step()
    t["now"] += 60
    s.step()  # too soon for the retry
    assert len(chat.bodies) == 1
    t["now"] += summaries.RETRY_AFTER_S
    s.step()
    assert len(chat.bodies) == 2
    t["now"] += 10 * summaries.RETRY_AFTER_S
    s.step()
    assert len(chat.bodies) == 2 and s.summaries(0) == {}


def test_ollama_down_is_not_a_bad_answer(tmp_path):
    s, frig, chat, t = make(tmp_path, [review("a", NOW - 1000, NOW - 900)],
                            [OSError("refused"), OSError("refused"), GOOD])
    for _ in range(3):
        t["now"] += 60
        s.step()
    assert set(s.summaries(0)) == {"a"}


def test_no_frames_counts_as_a_bad_answer(tmp_path):
    s, frig, chat, t = make(tmp_path, [review("a", NOW - 1000, NOW - 900)], [],
                            missing={"living_room_cam"})
    s.step()
    t["now"] += summaries.RETRY_AFTER_S + 1
    s.step()
    t["now"] += summaries.RETRY_AFTER_S + 1
    s.step()
    assert chat.bodies == [] and len(frig.snaps) == 6  # two tries of three frames


def test_summaries_persist_and_filter_by_start(tmp_path):
    reviews = [review("a", NOW - 1000, NOW - 900), review("b", NOW - 5000, NOW - 4900)]
    s, frig, chat, t = make(tmp_path, reviews, [GOOD, GOOD])
    s.step()
    t["now"] += 60
    s.step()
    again = Summarizer(frig, chat, lambda: True, str(tmp_path / "summaries.json"),
                       clock=lambda: t["now"], pet=PET)
    assert set(again.summaries(0)) == {"a", "b"}
    assert set(again.summaries(NOW - 2000)) == {"a"}


def test_short_review_frames_stay_inside_it(tmp_path):
    s, frig, chat, _ = make(tmp_path, [review("a", NOW - 1000, NOW - 997)], [GOOD])
    s.step()
    times = [t for _, t, _ in frig.snaps]
    assert all(NOW - 1000 <= x <= NOW - 997 for x in times) and len(times) == 3


def test_parse_turns_a_title_case_title_into_a_sentence():
    # the model often answers "Rex Investigates Near Couch"; the app reads sentences
    keep = summaries.name_words(PET)
    a = summaries.parse_answer('{"title": "Rex Investigates Near Couch", "summary": "He sniffs."}',
                               keep)
    assert a["title"] == "Rex investigates near couch"
    b = summaries.parse_answer('{"title": "Person Opens The TV Cabinet", "summary": "x"}')
    assert b["title"] == "Person opens the TV cabinet"
    c = summaries.parse_answer('{"title": "Rex naps on the couch", "summary": "x"}', keep)
    assert c["title"] == "Rex naps on the couch"  # already a sentence: unchanged


# --- the backlog (the story waits for it) ---------------------------------------------

def test_backlog_is_unknown_before_the_first_look(tmp_path):
    s, frig, chat, _ = make(tmp_path, [], [])
    assert s.backlog() is None


def test_backlog_counts_ended_items_without_a_summary(tmp_path):
    reviews = [review("a", NOW - 1000, NOW - 900), review("b", NOW - 5000, NOW - 4900),
               review("open", NOW - 100, None)]
    s, frig, chat, t = make(tmp_path, reviews, [GOOD, GOOD])
    s.step()
    assert s.backlog() == 1  # "a" is done; "b" waits; an open item is not waiting
    assert s.backlog(after=NOW - 2000) == 0
    assert s.backlog(after=NOW - 6000, before=NOW - 2000) == 1
    t["now"] += 60
    s.step()
    assert s.backlog() == 0


def test_backlog_is_kept_while_the_gpu_is_busy(tmp_path):
    s, frig, chat, _ = make(tmp_path, [review("a", NOW - 1000, NOW - 900)], [], free=False)
    s.step()
    assert s.backlog() == 1


def test_an_item_waiting_for_its_retry_is_backlog_and_a_given_up_one_is_not(tmp_path):
    s, frig, chat, t = make(tmp_path, [review("a", NOW - 1000, NOW - 900)],
                            ["nonsense", "still nonsense"])
    s.step()
    t["now"] += 60
    s.step()
    assert s.backlog() == 1  # tried once, waits for the retry
    t["now"] += summaries.RETRY_AFTER_S
    s.step()
    t["now"] += 60
    s.step()
    assert s.backlog() == 0  # given up after two tries


# --- the user's camera names ---------------------------------------------------------------

def test_the_prompt_holds_the_users_camera_name():
    r = review("a", NOW, NOW + 95)
    text = build_prompt(r, frames=3, pet=PET, title_of={"living_room_cam": "Emma's room"}.get)
    assert 'home camera "Emma\'s room"' in text and "Living room" not in text


def test_the_prompt_with_the_default_holds_the_derived_name():
    text = build_prompt(review("a", NOW, NOW + 95), frames=3, pet=PET)
    assert 'home camera "Living room"' in text


def test_sentence_case_keeps_the_proper_words_of_the_camera_title():
    from names import proper_words

    keep = proper_words("Emma's TV room")
    assert summaries.sentence_case("Rex Naps In Emma's TV Room", keep) == \
        "Rex naps in Emma's TV room"


def test_the_summarizer_asks_and_keeps_with_the_users_camera_name(tmp_path):
    title = json.dumps({"title": "Rex Sleeps In Emma's Room", "summary": "He sleeps."})
    frig, chat = FakeFrigate([review("a", NOW - 1000, NOW - 900)]), FakeChat([title])
    s = Summarizer(frig, chat, lambda: True, str(tmp_path / "summaries.json"),
                   clock=lambda: NOW, pet=PET, title_of={"living_room_cam": "Emma's room"}.get)
    s.step()
    assert '"Emma\'s room"' in chat.bodies[0]["messages"][0]["content"]
    assert s.summaries(0)["a"]["title"] == "Rex sleeps in Emma's room"


def test_the_summarizer_with_the_default_lowers_the_same_word(tmp_path):
    title = json.dumps({"title": "Rex Sleeps In Emma's Room", "summary": "He sleeps."})
    s, _, _, _ = make(tmp_path, [review("a", NOW - 1000, NOW - 900)], [title])
    s.step()
    assert s.summaries(0)["a"]["title"] == "Rex sleeps in emma's room"

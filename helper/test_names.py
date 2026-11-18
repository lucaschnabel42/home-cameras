"""Tests for names.py. Run: python -m pytest -q helper"""

import json
import os

import pytest

import names
from names import Conflict, Names, clean, place_phrase, proper_words

PLAN = {"rev": 0,
        "cameras": {"front_yard": {"name": "Front Door", "group": "g1"},
                    "kitchen_cam": {"group": "g2"},
                    "porch": {"name": "Emma's room"}},
        "groups": [{"id": "g1", "name": "Outside"}, {"id": "g2", "name": "Inside"}]}


def doc(cameras=None, groups=None, rev=0):
    return {"rev": rev, "cameras": cameras or {}, "groups": groups or []}


def refused(value):
    with pytest.raises(ValueError):
        clean(value)


# --- clean: camera keys -------------------------------------------------------------

def test_the_plan_document_is_accepted_as_it_is():
    assert clean(PLAN) == PLAN


def test_a_camera_key_of_letters_digits_underscore_and_hyphen_is_accepted():
    got = clean(doc({"Front_yard-2": {"name": "Yard"}}))
    assert got["cameras"] == {"Front_yard-2": {"name": "Yard"}}


@pytest.mark.parametrize("key", ["front yard", "", "porch.cam", "café", "a/b"])
def test_a_bad_camera_key_is_refused(key):
    refused(doc({key: {"name": "Yard"}}))


def test_64_camera_keys_are_accepted_and_65_are_refused():
    many = {f"cam{i}": {"name": f"Cam {i}"} for i in range(64)}
    assert len(clean(doc(many))["cameras"]) == 64
    many["cam64"] = {"name": "Cam 64"}
    refused(doc(many))


# --- clean: names ------------------------------------------------------------------------

def test_white_space_is_trimmed_and_collapsed():
    got = clean(doc({"porch": {"name": "  Front    porch  "}},
                    [{"id": "g1", "name": " Out   side "}]))
    assert got["cameras"]["porch"]["name"] == "Front porch"
    assert got["groups"] == [{"id": "g1", "name": "Out side"}]


def test_a_name_of_32_characters_is_accepted_and_33_is_refused():
    assert clean(doc({"porch": {"name": "a" * 32}}))["cameras"]["porch"]["name"] == "a" * 32
    refused(doc({"porch": {"name": "a" * 33}}))


def test_the_length_is_counted_after_the_collapse():
    name = "a" + " " * 10 + "b" * 30
    assert clean(doc({"porch": {"name": name}}))["cameras"]["porch"]["name"] == "a " + "b" * 30


@pytest.mark.parametrize("name", ["2nd floor", "Émile's room", "Emma’s room",
                                  "Mom & Dad's room.", "St. Mark-1", "寝室"])
def test_a_name_of_the_allowed_characters_is_accepted(name):
    assert clean(doc({"porch": {"name": name}}))["cameras"]["porch"]["name"] == name


@pytest.mark.parametrize("name", ["-den", "'den", ".den", "&den", "Den \"A\"", "Den\nroom",
                                  "Den {x}", "Den <b>", "Den\tA", "Den_A", "Den/A",
                                  "Den ½"])
def test_a_name_with_another_character_is_refused(name):
    refused(doc({"porch": {"name": name}}))


def test_a_name_that_is_not_text_is_refused():
    refused(doc({"porch": {"name": 3}}))
    refused(doc(groups=[{"id": "g1", "name": None}]))


def test_an_empty_name_is_no_name():
    got = clean(doc({"porch": {"name": "   ", "group": "g1"}}, [{"id": "g1", "name": "Out"}]))
    assert got["cameras"] == {"porch": {"group": "g1"}}


def test_an_entry_with_neither_field_is_dropped():
    got = clean(doc({"porch": {}, "yard": {"name": ""}, "den": {"name": " ", "group": ""},
                     "hall": {"name": "Hall"}}))
    assert got["cameras"] == {"hall": {"name": "Hall"}}


def test_a_camera_entry_that_is_not_an_object_is_refused():
    refused(doc({"porch": "Porch"}))


# --- clean: groups --------------------------------------------------------------------------

def test_the_order_of_the_groups_is_kept():
    groups = [{"id": "b", "name": "B"}, {"id": "a", "name": "A"}, {"id": "c", "name": "C"}]
    assert [g["id"] for g in clean(doc(groups=groups))["groups"]] == ["b", "a", "c"]


@pytest.mark.parametrize("gid", ["G1", "g-1", "", "abcdefghijklm", "g 1", 1])
def test_a_bad_group_id_is_refused(gid):
    refused(doc(groups=[{"id": gid, "name": "Out"}]))


def test_a_group_id_of_12_characters_is_accepted():
    assert clean(doc(groups=[{"id": "abcdefghij12", "name": "Out"}]))["groups"][0]["id"] \
        == "abcdefghij12"


def test_a_group_id_two_times_is_refused():
    refused(doc(groups=[{"id": "g1", "name": "Out"}, {"id": "g1", "name": "In"}]))


def test_a_group_name_two_times_is_refused_with_letter_case_ignored():
    refused(doc(groups=[{"id": "g1", "name": "Outside"}, {"id": "g2", "name": "OUTSIDE"}]))


def test_group_names_compare_in_lower_case_as_the_app_does():
    # The app compares with toLowerCase: "Straße" and "STRASSE" are two names there.
    doc = {"rev": 0, "cameras": {}, "groups": [{"id": "g1", "name": "Straße"}, {"id": "g2", "name": "STRASSE"}]}
    assert len(clean(doc)["groups"]) == 2


def test_a_group_with_an_empty_name_is_refused():
    refused(doc(groups=[{"id": "g1", "name": "  "}]))


def test_24_groups_are_accepted_and_25_are_refused():
    groups = [{"id": f"g{i}", "name": f"Group {i}"} for i in range(24)]
    assert len(clean(doc(groups=groups))["groups"]) == 24
    groups.append({"id": "g24", "name": "Group 24"})
    refused(doc(groups=groups))


def test_an_unknown_group_id_of_a_camera_is_refused():
    refused(doc({"porch": {"group": "g9"}}, [{"id": "g1", "name": "Out"}]))


def test_a_group_that_is_not_text_is_refused():
    refused(doc({"porch": {"group": 1}}, [{"id": "g1", "name": "Out"}]))


# --- clean: the document ---------------------------------------------------------------------

@pytest.mark.parametrize("value", [None, [], "x", {"cameras": {}, "groups": []},
                                   {"rev": "0", "cameras": {}, "groups": []},
                                   {"rev": True, "cameras": {}, "groups": []},
                                   {"rev": -1, "cameras": {}, "groups": []},
                                   {"rev": 0, "cameras": [], "groups": []},
                                   {"rev": 0, "cameras": {}, "groups": {}},
                                   {"rev": 0, "groups": []},
                                   {"rev": 0, "cameras": {}, "groups": ["g1"]}])
def test_a_document_of_a_wrong_shape_is_refused(value):
    refused(value)


def test_a_refusal_says_what_is_wrong_in_plain_words():
    with pytest.raises(ValueError, match="porch"):
        clean(doc({"porch": {"group": "g9"}}))


def test_clean_does_not_change_its_input():
    before = json.loads(json.dumps(PLAN))
    clean(dict(PLAN, cameras=dict(PLAN["cameras"], den={"name": "  Den  "})))
    assert PLAN == before


# --- the store ----------------------------------------------------------------------------------

def test_with_no_file_the_document_is_empty_at_rev_0(tmp_path):
    assert Names(str(tmp_path / "names.json")).doc() == {"rev": 0, "cameras": {}, "groups": []}


def test_a_write_gives_rev_1_and_survives_a_new_store(tmp_path):
    path = str(tmp_path / "names.json")
    stored = Names(path).replace(PLAN)
    assert stored == dict(PLAN, rev=1)
    assert Names(path).doc() == dict(PLAN, rev=1)


def test_a_stale_rev_raises_the_conflict_with_the_stored_document(tmp_path):
    path = str(tmp_path / "names.json")
    store = Names(path)
    store.replace(PLAN)
    other = dict(PLAN, cameras={"porch": {"name": "Porch"}})
    with pytest.raises(Conflict) as err:
        store.replace(other)
    assert err.value.stored == dict(PLAN, rev=1)
    assert store.doc() == dict(PLAN, rev=1)
    assert Names(path).doc() == dict(PLAN, rev=1)


def test_a_bad_document_stores_nothing(tmp_path):
    path = str(tmp_path / "names.json")
    store = Names(path)
    with pytest.raises(ValueError):
        store.replace(doc({"porch": {"name": "<b>"}}))
    assert store.doc()["rev"] == 0 and not os.path.exists(path)


def test_the_document_given_out_is_a_copy(tmp_path):
    store = Names(str(tmp_path / "names.json"))
    store.replace(PLAN)
    store.doc()["cameras"]["porch"]["name"] = "Changed"
    assert store.title("porch") == "Emma's room"


@pytest.mark.parametrize("content", ['["a"]', '{"rev": 2, "cameras": {"a b": {}}, "groups": []}',
                                     '{"rev": "x", "cameras": {}, "groups": []}', "not json"])
def test_a_file_of_a_wrong_shape_loads_as_the_empty_document(tmp_path, content):
    path = tmp_path / "names.json"
    path.write_text(content)
    assert Names(str(path)).doc() == {"rev": 0, "cameras": {}, "groups": []}


def test_title_is_the_users_name_else_the_derived_name(tmp_path):
    store = Names(str(tmp_path / "names.json"))
    store.replace(PLAN)
    assert store.title("front_yard") == "Front Door"
    assert store.title("kitchen_cam") == "Kitchen"
    assert store.title("living_room_cam") == "Living room"


# --- the place phrase ---------------------------------------------------------------------------

@pytest.mark.parametrize("title, phrase", [
    ("Living room", "in the living room"),
    ("Front porch", "at the front porch"),
    ("Front Door", "at the front door"),
    ("TV room", "in the TV room"),
    ("Emma's room", "in Emma's room"),
    ("The den", "in the den"),
    ("Garage 2", "at the garage 2"),
])
def test_the_place_phrase_table(title, phrase):
    assert place_phrase(title) == phrase


def test_the_curly_apostrophe_counts_as_a_possessive():
    assert place_phrase("Emma’s room") == "in Emma’s room"


def test_a_single_capital_letter_stays():
    assert place_phrase("Room A") == "in the room A"


def test_proper_words_are_the_words_that_rule_1_keeps():
    assert proper_words("TV room") == frozenset({"TV", "room"})
    assert proper_words("Emma's Den") == frozenset({"Emma's"})
    assert proper_words("Front Door") == frozenset()


def test_the_derived_name_has_no_proper_word_of_its_own():
    assert names.camera_name("living_room_cam") == "Living room"

import pytest

import envfile


def test_quote_keeps_each_value_as_compose_reads_it():
    for value in ["Europe/Berlin", "", "a b", "p#ss", "pa$$word", 'say "hi"', "it's",
                  "it's $5 \"q\"", "a b # c"]:
        line = f"K={envfile.quote(value)}"
        assert envfile.parse(line) == {"K": value}, value
        assert envfile.problems(line) == [], value


def test_a_value_with_a_single_quote_and_a_backslash_is_refused():
    # In double quotes, Docker reads a backslash before a letter as a control character.
    with pytest.raises(ValueError):
        envfile.quote("it's a\\b")


@pytest.mark.parametrize("line, words", [
    ("WYZE_PASSWORD=pa$word", "$ sign"),
    ("WYZE_PASSWORD=pass #1", "after a space"),
    ("WYZE_PASSWORD='it's'", "single quote inside"),
    ('WYZE_PASSWORD="pa$word"', "inside double quotes"),
    ('WYZE_PASSWORD="open', "no closing"),
    ("WYZE_PASSWORD=\u2018secret\u2019", "curly quote"),
])
def test_problems_name_the_key_and_never_the_value(line, words):
    ((key, what),) = envfile.problems(line)
    assert key == "WYZE_PASSWORD" and words in what
    assert "word" not in what and "secret" not in what


def test_values_that_docker_reads_as_typed_are_no_problem():
    text = "A=plain\nB=pa ss\nC=pa#ss\nD='a $b #c'\nE=\"x \\$y\"\nF=it's\n# G=$x\n"
    assert envfile.problems(text) == []


def test_plain_values_stay_plain():
    assert envfile.quote("./media") == "./media"
    assert envfile.quote("mailto:a@b.c") == "mailto:a@b.c"
    assert envfile.quote("a b") == "'a b'"


def test_parse_skips_comments_and_strips_a_trailing_comment():
    text = "# a comment\nTZ=UTC # the zone\n\nexport PET_NAME=Rex\n#X=1\n"
    assert envfile.parse(text) == {"TZ": "UTC", "PET_NAME": "Rex"}


def test_update_keeps_comments_and_order_and_adds_new_keys():
    text = "# zone\nTZ=UTC\n# pet\nPET_NAME=\n"
    out = envfile.update(text, {"PET_NAME": "Rex", "TZ": "Europe/Berlin", "NEW": "x y"})
    assert out == "# zone\nTZ=Europe/Berlin\n# pet\nPET_NAME=Rex\n\nNEW='x y'\n"

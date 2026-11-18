"""The user's camera names and camera groups, kept in DATA_DIR/names.json.

The app reads the document at GET /names and writes a whole document at
POST /names (app.py). The document:

    {"rev": 1,
     "cameras": {"front_yard": {"name": "Front Door", "group": "g1"}},
     "groups": [{"id": "g1", "name": "Outside"}]}

rev is the revision. A write must give the rev it read; the store then keeps
the document with rev + 1. A write with another rev raises Conflict, and the
store keeps what it has. The order of "groups" is the order on the screen.

The name rule (clean) keeps a name safe in a push message and in a model
prompt: a name holds only letters, digits, space, and ' ’ - & . characters.

This module also holds the place phrase ("in the living room"), which the
app computes with the same rule (ui/app/src/lib/names.ts).

What this does not do:
- It does not know which cameras Frigate has. A key of a camera that no
  longer exists stays in the document until the app removes it.
- It does not put a camera in more than one group.
- It does not keep old revisions. A write replaces the document.
- The place phrase uses "at" or "in" only. A name that needs another
  preposition ("on the deck") gets the wrong one.
"""

import copy
import logging
import re
import threading
import unicodedata

import jsonstore

log = logging.getLogger("cam-helper.names")

CAMERA_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
GROUP_ID = re.compile(r"^[a-z0-9]{1,12}$")
MAX_CAMERAS = 64
MAX_GROUPS = 24
NAME_MAX = 32
NAME_MARKS = set(" '’-&.")
EMPTY = {"rev": 0, "cameras": {}, "groups": []}
CONFLICT = "The names changed on another device."

OUTDOOR = re.compile(r"porch|door|yard|drive|garage|gate|patio|deck|garden|street")
_SPACES = re.compile(r" +")


def camera_name(camera):
    """living_room_cam -> "Living room": the name derived from the Frigate key."""
    name = camera[:-4] if camera.endswith("_cam") else camera
    return name.replace("_", " ").strip().capitalize()


# --- the place phrase ---------------------------------------------------------------------

def _possessive(word):
    return word.endswith("'s") or word.endswith("’s")


def _plain_word(word):
    """Rule 1: a capital letter first, then no other capital and one or more
    lower-case letters: "Door", "Cam1", "Back-yard"; not "TV", "A" or "A1"."""
    if not word or unicodedata.category(word[0]) != "Lu":
        return False
    rest = [unicodedata.category(ch) for ch in word[1:]]
    return "Lu" not in rest and "Ll" in rest


def _rule_1(word):
    return word.lower() if _plain_word(word) and not _possessive(word) else word


def in_sentence(title):
    """The title as it reads inside a sentence: "Front Door" -> "front door",
    "TV room" -> "TV room" (rule 1 of the place phrase)."""
    return " ".join(_rule_1(w) for w in title.split(" ") if w)


def proper_words(title):
    """The words of the title that rule 1 keeps as they are typed."""
    return frozenset(w for w in title.split(" ") if w and _rule_1(w) == w)


def place_phrase(title):
    """ "Living room" -> "in the living room"; "Emma's room" -> "in Emma's room".

    1. Rule 1 (in_sentence) sets the letter case of each word.
    2. "at" when the lower-case title holds an outdoor word, else "in".
    3. "the" follows, unless a word is a possessive ('s or ’s) or the title
       starts with "the ".
    """
    lower = title.lower()
    words = [w for w in title.split(" ") if w]
    prep = "at" if OUTDOOR.search(lower) else "in"
    article = not any(_possessive(w) for w in words) and not lower.startswith("the ")
    return f"{prep} {'the ' if article else ''}{in_sentence(title)}"


# --- the name rule ------------------------------------------------------------------------

def _first_ok(ch):
    return unicodedata.category(ch)[0] == "L" or unicodedata.category(ch) == "Nd"


def clean_name(value, what):
    """The name with its spaces trimmed and collapsed, or "" for no name.
    ValueError when the name breaks the rule. what names the item for the
    error sentence."""
    if not isinstance(value, str):
        raise ValueError(f"The name of {what} must be text.")
    # Only the space character collapses. A tab or a line break is refused,
    # so that a push message and a prompt stay on one line.
    name = _SPACES.sub(" ", value).strip(" ")
    if not name:
        return ""
    if len(name) > NAME_MAX:
        raise ValueError(f"The name of {what} is longer than {NAME_MAX} characters.")
    if not _first_ok(name[0]):
        raise ValueError(f"The name of {what} must start with a letter or a digit.")
    for ch in name[1:]:
        if not (_first_ok(ch) or ch in NAME_MARKS):
            raise ValueError(f"The name of {what} can hold only letters, digits, spaces, "
                             "and the marks ' ’ - & .")
    return name


def _rev(doc):
    rev = doc.get("rev") if isinstance(doc, dict) else None
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 0:
        raise ValueError("The document must have a rev that is a whole number of 0 or more.")
    return rev


def clean(doc):
    """The document, checked and normalised. ValueError with a plain reason
    when the document breaks a rule. Does not change its input.

    A camera entry with no name and no group is dropped. An empty name or an
    empty group is the same as none.
    """
    rev = _rev(doc)
    cameras, groups = doc.get("cameras"), doc.get("groups")
    if not isinstance(cameras, dict):
        raise ValueError("The document must have \"cameras\", an object.")
    if not isinstance(groups, list):
        raise ValueError("The document must have \"groups\", a list.")
    if len(cameras) > MAX_CAMERAS:
        raise ValueError(f"The document can name at most {MAX_CAMERAS} cameras.")
    if len(groups) > MAX_GROUPS:
        raise ValueError(f"The document can have at most {MAX_GROUPS} groups.")

    out_groups, ids, seen_names = [], set(), set()
    for g in groups:
        if not isinstance(g, dict):
            raise ValueError("Each group must be an object with an id and a name.")
        gid = g.get("id")
        if not isinstance(gid, str) or not GROUP_ID.match(gid):
            raise ValueError("A group id must be 1 to 12 lower-case letters or digits.")
        if gid in ids:
            raise ValueError(f"The group id {gid} is used two times.")
        name = clean_name(g.get("name"), f"group {gid}")
        if not name:
            raise ValueError(f"Group {gid} must have a name.")
        # lower(), not casefold(): the app compares with toLowerCase, and the
        # two sides must refuse the same documents.
        if name.lower() in seen_names:
            raise ValueError(f"Two groups have the name {name}.")
        ids.add(gid)
        seen_names.add(name.lower())
        out_groups.append({"id": gid, "name": name})

    out_cameras = {}
    for key, entry in cameras.items():
        if not CAMERA_KEY.match(key):
            raise ValueError("A camera key can hold only letters, digits, _ and -.")
        if not isinstance(entry, dict):
            raise ValueError(f"The entry of camera {key} must be an object.")
        item = {}
        name = clean_name(entry.get("name", ""), f"camera {key}") \
            if entry.get("name") is not None else ""
        if name:
            item["name"] = name
        group = entry.get("group")
        if group is not None and not isinstance(group, str):
            raise ValueError(f"The group of camera {key} must be a group id.")
        if group:
            if group not in ids:
                raise ValueError(f"Camera {key} is in group {group}, which does not exist.")
            item["group"] = group
        if item:
            out_cameras[key] = item
    return {"rev": rev, "cameras": out_cameras, "groups": out_groups}


# --- the store ----------------------------------------------------------------------------

class Conflict(Exception):
    """A write gave a rev that is not the stored rev. stored is the stored
    document."""

    def __init__(self, stored):
        super().__init__(CONFLICT)
        self.stored = stored


class Names:
    """The names document in a JSON file. One lock: the server answers each
    request in its own thread, and the loops read titles.

    A file of a wrong shape loads as the empty document, with a warning. The
    next write then replaces it.
    """

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        stored = jsonstore.load(path, None)
        self._doc = copy.deepcopy(EMPTY)
        if stored is not None:
            try:
                self._doc = clean(stored)
            except ValueError as exc:
                log.warning("%s has a wrong shape (%s); starting from empty", path, exc)

    def doc(self):
        with self.lock:
            return copy.deepcopy(self._doc)

    def replace(self, doc):
        """Store doc with rev + 1 and return the stored document. Raises
        Conflict when doc["rev"] is not the stored rev, and ValueError when doc
        breaks a rule. Then nothing is stored."""
        rev = _rev(doc)
        with self.lock:
            if rev != self._doc["rev"]:
                raise Conflict(copy.deepcopy(self._doc))
            new = clean(doc)
            new["rev"] = rev + 1
            jsonstore.save(self.path, new)
            self._doc = new
            return copy.deepcopy(new)

    def title(self, camera):
        """The user's name of the camera, else the name derived from its key."""
        with self.lock:
            name = self._doc["cameras"].get(camera, {}).get("name")
        return name or camera_name(camera)

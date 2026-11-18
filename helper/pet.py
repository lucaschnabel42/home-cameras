"""The pet of the home, from the settings, and the words that name it.

The pet day, the story, the summaries, and the alerts all name the pet. This
module is the one place that turns the settings into those words.

The pet day is off unless both PET_NAME and PET_CAMERA are set. With no pet,
the other modules use plain words: "a dog", "a cat".

What this does not do:
- It knows one pet only. A home with two dogs gets one name for both.
- It supports the Frigate labels "dog" and "cat" only. Frigate's default
  model has no other pet label.
"""

import re
from dataclasses import dataclass

LABELS = ("dog", "cat")
SEXES = ("male", "female")
# (subject, object, possessive, reflexive) for each sex.
PRONOUNS = {"male": ("he", "him", "his", "himself"),
            "female": ("she", "her", "her", "herself")}
# A name is shown in the app and put into model prompts, so it is kept to
# plain letters, spaces, hyphens, and apostrophes.
NAME = re.compile(r"^[A-Za-z][A-Za-z' -]{0,31}$")
CAMERA = re.compile(r"^[A-Za-z0-9_-]+$")
# The Frigate sound labels that are the pet's own voice. The audio listen
# list in the Frigate config holds bark and howl; it holds no cat sound.
SOUNDS = {"dog": frozenset({"bark", "howl"}), "cat": frozenset()}


@dataclass(frozen=True)
class Pet:
    """One pet: its name, the camera of its pet day, its label, its sex."""

    name: str
    camera: str
    label: str = "dog"
    sex: str = "male"

    def __post_init__(self):
        if not NAME.match(self.name):
            raise ValueError("PET_NAME must be 1 to 32 letters, spaces, hyphens or apostrophes")
        if not CAMERA.match(self.camera):
            raise ValueError("PET_CAMERA must be a Frigate camera name")
        if self.label not in LABELS:
            raise ValueError(f"PET_LABEL must be one of {', '.join(LABELS)}")
        if self.sex not in SEXES:
            raise ValueError(f"PET_SEX must be one of {', '.join(SEXES)}")

    @property
    def he(self):
        return PRONOUNS[self.sex][0]

    @property
    def him(self):
        return PRONOUNS[self.sex][1]

    @property
    def his(self):
        return PRONOUNS[self.sex][2]

    @property
    def wrong_pronouns(self):
        """The pronouns of the other sex, which a story must not use."""
        if self.sex == "male":
            return {"she", "her", "hers", "herself"}
        return {"he", "him", "his", "himself"}

    @property
    def sounds(self):
        """The Frigate sound labels of the pet's own voice."""
        return SOUNDS[self.label]

    @property
    def other_animal(self):
        """The pet label that is not this pet: a cat for a dog, a dog for a cat."""
        return "cat" if self.label == "dog" else "dog"


def from_env(env):
    """The Pet from PET_NAME, PET_CAMERA, PET_LABEL and PET_SEX, or None.

    None when PET_NAME or PET_CAMERA is empty: the pet day is then off. A bad
    value raises ValueError, so a typing error stops the helper at start with
    a clear message instead of a silent fallback.
    """
    name = (env.get("PET_NAME") or "").strip()
    camera = (env.get("PET_CAMERA") or "").strip()
    if not name or not camera:
        return None
    return Pet(name=name, camera=camera,
               label=(env.get("PET_LABEL") or "dog").strip().lower(),
               sex=(env.get("PET_SEX") or "male").strip().lower())


def client_config(pet, summaries_on):
    """The body of GET /config: what the app shows and which features are on."""
    return {
        "pet": {"name": pet.name, "camera": pet.camera, "label": pet.label} if pet else None,
        "features": {"summaries": bool(summaries_on), "petDay": pet is not None},
    }

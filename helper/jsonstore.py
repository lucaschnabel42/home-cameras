"""Read and write a small JSON state file, atomically."""

import json
import logging
import os

log = logging.getLogger("cam-helper.store")


def load(path, default):
    """The JSON value at path; default if the file is missing or broken."""
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        log.warning("%s is unreadable; starting from empty", path)
        return default


def save(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

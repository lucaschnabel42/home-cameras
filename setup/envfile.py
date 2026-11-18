"""Read and write the .env file of the install, and keep its comments.

Docker Compose reads .env for the ${...} values of docker-compose.yml. The
rules below were measured with "docker compose config":
- An unquoted value is cut at " #", and "$name" in it is replaced by another
  setting (usually an empty one). A space inside it stays.
- A value in single quotes is read as it is: a space, "#", "$" and a double
  quote are safe. A single quote inside single quotes is a read error.
- A value in double quotes reads \\" as a quote and \\$ as a dollar sign,
  but a backslash before a letter becomes a control character.

So this module writes a value plain when it holds only safe characters, in
single quotes when it holds no single quote, and in double quotes (with \\"
and \\$) when it holds a single quote and no backslash. It refuses a value
with both a single quote and a backslash. problems() finds the same faults
in a value that a person typed by hand.

What this does not do:
- It does not read multi-line values. The settings of this install are all
  one line.
"""

import re

SAFE = re.compile(r"^[A-Za-z0-9_./:@,+=-]*$")
LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
CURLY = "‘’“”"


def quote(value):
    """The value as Compose reads it back from a .env line; ValueError when
    no form is safe."""
    if SAFE.match(value):
        return value
    if "'" not in value:
        return f"'{value}'"
    if "\\" in value:
        raise ValueError("a value with both ' and \\ cannot be written safely")
    return '"' + value.replace('"', '\\"').replace("$", "\\$") + '"'


def unquote(raw):
    """The value of the text after "=" on a .env line."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1]
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        return re.sub(r'\\(["$\\])', r"\1", raw[1:-1])
    # An unquoted value ends at " #" (a comment).
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def _lines(text):
    for line in text.splitlines():
        m = LINE.match(line)
        if m and not line.lstrip().startswith("#"):
            yield m.group(1), m.group(2)


def parse(text):
    """{key: value} of every KEY=VALUE line; a later line wins."""
    return {key: unquote(raw) for key, raw in _lines(text)}


def problems(text):
    """[(key, what is wrong)] for each line that Compose reads differently
    from what the person typed. The messages never hold the value."""
    out = []
    for key, raw in _lines(text):
        value = raw.strip()
        if not value:
            continue
        if value[0] in CURLY or value[-1] in CURLY:
            out.append((key, "starts or ends with a curly quote. Type straight quotes ' (turn "
                             "off smart quotes in the editor)."))
        elif value[0] == "'":
            if len(value) < 2 or value[-1] != "'" or "'" in value[1:-1]:
                out.append((key, "has a single quote inside single quotes. Docker cannot read "
                                 "it. Change that value so it has no ' character."))
        elif value[0] == '"':
            if len(value) < 2 or value[-1] != '"':
                out.append((key, "has an opening \" with no closing one. Put the whole value "
                                 "in single quotes instead."))
            elif re.search(r"(?<!\\)\$", value[1:-1]):
                out.append((key, "has a $ sign inside double quotes. Docker reads $ as the start "
                                 "of a setting name. Use single quotes instead."))
        elif "$" in value:
            out.append((key, "has a $ sign. Docker reads $ as the start of a setting name. Put "
                             "the whole value in single quotes: " + key + "='...'"))
        elif re.search(r"\s#", value):
            out.append((key, "has a # after a space. Docker reads the rest as a comment. Put "
                             "the whole value in single quotes: " + key + "='...'"))
    return out


def update(text, changes):
    """text with each key of changes set: in place when the key has a line,
    else in a new line at the end. The comments and the order stay."""
    done = set()
    out = []
    for line in text.splitlines():
        m = LINE.match(line)
        if m and not line.lstrip().startswith("#") and m.group(1) in changes:
            key = m.group(1)
            out.append(f"{key}={quote(changes[key])}")
            done.add(key)
        else:
            out.append(line)
    rest = [k for k in changes if k not in done]
    if rest:
        if out and out[-1].strip():
            out.append("")
        out += [f"{k}={quote(changes[k])}" for k in rest]
    return "\n".join(out) + "\n"

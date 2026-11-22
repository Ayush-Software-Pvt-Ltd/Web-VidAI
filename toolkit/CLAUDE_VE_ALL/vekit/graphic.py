"""`ve.py graphic`: a full-screen motion graphic from a template with variables.

  ve.py graphic <VIDEO> <name> --template title --var title="..." kicker="..." [--duration S]
  ve.py graphic --list

Writes <VIDEO>/CLAUDE_VE/gfx_src/<name>/ (index.html, graphic.json and, for the image template, photo.<ext>),
the folder `VIS` entries "G:<name>" and `ve.py gfx` read.  The page is made for the project's orientation
(project.json width and height): 1920x1080 or 1080x1920, opaque, always moving, text that fits the safe area.

Templates are the folders gfx/templates/graphic_<name>/ (index.html with placeholders, template.json with the
variables).  gfx/templates/_graphic_kit/ holds what they share (kit.js, kit.css, common.json: colours and font).
The chosen values are written as the defaults the page declares, so `ve.py gfx` renders them with no further
input, and into graphic.json {"template", "variables"} for the edit project (hfproject.py).
"""
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

from .paths import TEMPLATES, project_dir, video_dir

KIT_DIR = TEMPLATES / "_graphic_kit"
PREFIX = "graphic_"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
FONT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
IMAGE_MAX = 40 * 1024 * 1024
ICONS = ("check", "star", "bolt", "heart", "play", "shield", "phone", "gift", "target", "clock", "globe", "rupee", "cart")
DURATION_RANGE = (2.0, 30.0)
SIZES = {"landscape": (1920, 1080), "portrait": (1080, 1920)}
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def fail(message):
    raise SystemExit(f"graphic: {message}")


def common_variables():
    return json.loads((KIT_DIR / "common.json").read_text(encoding="utf-8"))


def templates():
    """{short name: meta} of every graphic template; meta has "summary", "duration" and "variables" (the
    template's own, then the common ones) and "folder"."""
    out = {}
    for d in sorted(TEMPLATES.glob(PREFIX + "*")):
        if not (d / "index.html").is_file():
            continue
        meta = json.loads((d / "template.json").read_text(encoding="utf-8"))
        meta["folder"] = d
        meta["id"] = d.name
        meta["variables"] = meta["variables"] + common_variables()
        out[d.name[len(PREFIX):]] = meta
    return out


def list_lines():
    lines = []
    for name, meta in templates().items():
        own = meta["variables"][:-len(common_variables())]
        parts = []
        for v in own:
            s = v["id"] + ("*" if v.get("required") else "")
            if v["type"] == "enum":
                s += "=" + "|".join(v["choices"])
            elif v["type"] == "list":
                s += "=a|b|c"
            parts.append(s)
        lines.append(f"{name} - {meta['summary']}.  Variables: {' '.join(parts)}")
    common = " ".join(f"{v['id']}={v['default']}" for v in common_variables())
    lines.append(f"Every template also takes (defaults): {common}.  * is required; colours are #RGB or #RRGGBB; "
                 "items are separated by |.")
    return lines


def parse_assignments(items):
    given = {}
    for item in items or []:
        key, eq, value = item.partition("=")
        if not eq or not re.fullmatch(r"[a-z][a-z0-9_]*", key):
            fail(f"'{item}' is not key=value; put quotes around a value that contains spaces.")
        given[key] = value
    return given


def clean_text(key, value, spec):
    value = re.sub(r"\s*\n\s*", " ", value.replace("\r", "")).strip()
    if CONTROL.search(value):
        fail(f"{key} contains a control character.")
    if len(value) > spec.get("max", 200):
        fail(f"{key} is {len(value)} characters; at most {spec.get('max', 200)}.")
    return value


def clean_list(key, value, spec):
    items = [x.strip() for x in re.split(r"\||\n", value) if x.strip()]
    lo, hi = spec.get("min_items", 1), spec.get("max_items", 6)
    if not lo <= len(items) <= hi:
        fail(f"{key} needs {lo} to {hi} items separated by |, not {len(items)}.")
    for x in items:
        clean_text(key, x, spec)
    return "|".join(items)


def clean_value(spec, value, main):
    """The cleaned string of one variable, or a SystemExit with a one-line reason."""
    key, kind = spec["id"], spec["type"]
    if kind == "text":
        value = clean_text(key, value, spec)
        if spec.get("required") and not value:
            fail(f"{key} is required and must not be empty.")
        return value
    if kind == "list":
        return clean_list(key, value, spec)
    if kind == "color":
        if not COLOR_RE.match(value.strip()):
            fail(f"{key} must be a colour like #1B2A5C or #fa0, not '{value}'.")
        return value.strip().upper()
    if kind == "font":
        if not FONT_RE.match(value.strip()):
            fail(f"{key} must be a font family name (letters, digits, spaces), not '{value}'.")
        return value.strip()
    if kind == "int":
        if not re.fullmatch(r"\d{1,4}", value.strip()) or not spec["min"] <= int(value) <= spec["max"]:
            fail(f"{key} must be a whole number from {spec['min']} to {spec['max']}, not '{value}'.")
        return str(int(value))
    if kind == "enum":
        if value.strip() not in spec["choices"]:
            fail(f"{key} must be one of {', '.join(spec['choices'])}, not '{value}'.")
        return value.strip()
    if kind == "icon":
        value = value.strip()
        if value in ICONS:
            return value
        if not value or len(value) > 4 or CONTROL.search(value) or (value.isascii() and value.isalnum() and len(value) > 2):
            fail(f"{key} must be one of {', '.join(ICONS)} or one short symbol or emoji, not '{value}'.")
        return value
    if kind == "image":
        return value.strip()                        # checked and copied by build()
    fail(f"the template declares an unknown variable type {kind}.")


def resolve_variables(meta, given, main):
    specs = {v["id"]: v for v in meta["variables"]}
    for key in given:
        if key not in specs:
            fail(f"'{key}' is not a variable of {meta['id'][len(PREFIX):]}; use one of {', '.join(specs)}.")
    values = {}
    for key, spec in specs.items():
        if key in given:
            values[key] = clean_value(spec, given[key], main)
        elif spec.get("required"):
            fail(f"the variable {key} is required: --var {key}=...")
        else:
            values[key] = spec["default"]
    if "image" in specs and values["image"]:
        values["image"] = check_image(values["image"], main)
    elif "image" in specs:
        values["image"] = ""
    return values


def check_image(value, main):
    p = Path(os.path.expanduser(value))
    if not p.is_absolute():
        p = video_dir(main) / p
    if p.suffix.lower() not in IMAGE_EXT:
        fail(f"image must be a png, jpg or webp file, not '{value}'.")
    if not p.is_file():
        fail(f"image file not found: {p}")
    if p.stat().st_size > IMAGE_MAX:
        fail(f"image {p.name} is larger than {IMAGE_MAX // 2 ** 20} MB.")
    return str(p)


def check_duration(text, meta, values):
    if text is None:
        d = meta.get("duration", 5) + meta.get("duration_per_item", 0) * len(
            [x for x in values.get("items", "").split("|") if x])
        return round(d, 1)
    try:
        d = float(text)
    except ValueError:
        fail(f"--duration must be a number of seconds, not '{text}'.")
    lo, hi = DURATION_RANGE
    if not lo <= d <= hi:
        fail(f"--duration must be from {lo:g} to {hi:g} seconds, not {text}.")
    return round(d, 2)


def orientation(main, forced):
    if forced:
        return forced
    pj = project_dir(main) / "project.json"
    if not pj.is_file():
        fail("this video has no project.json yet; run `ve.py prep` first or pass --orientation landscape|portrait.")
    p = json.loads(pj.read_text(encoding="utf-8"))
    return "landscape" if int(p.get("width", 1080)) >= int(p.get("height", 1920)) else "portrait"


def attr_json(value):
    """JSON for a single-quoted HTML attribute that stays valid JSON and holds no apostrophe."""
    text = json.dumps(value, ensure_ascii=False)
    return text.replace("&", "&amp;").replace("'", "&#39;").replace("<", "&lt;").replace(">", "&gt;")


def script_json(value):
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def render_page(meta, values, duration, size, image_name):
    text = (meta["folder"] / "index.html").read_text(encoding="utf-8")
    text = text.replace("/*@KIT_CSS*/", (KIT_DIR / "kit.css").read_text(encoding="utf-8"))
    text = text.replace("/*@KIT_JS*/", (KIT_DIR / "kit.js").read_text(encoding="utf-8"))
    shown = dict(values, image=image_name or "")
    declared = [{"id": k, "type": "string", "label": k, "default": v} for k, v in shown.items()]
    dur = f"{duration:g}"
    fills = {"W": str(size[0]), "H": str(size[1]), "DURATION": dur, "RES": "landscape" if size[0] > size[1] else "portrait",
             "DECLARED": attr_json(declared), "DEFAULTS": script_json(shown), "IMAGE": image_name or ""}
    text = re.sub(r"@(W|H|DURATION|RES|DECLARED|DEFAULTS|IMAGE)@", lambda m: fills[m.group(1)], text) if image_name else \
        re.sub(r"@(W|H|DURATION|RES|DECLARED|DEFAULTS|IMAGE)@", lambda m: fills[m.group(1)],
               "\n".join(line for line in text.split("\n") if "@IMAGE@" not in line))
    return text


def build(main, name, template, given, duration=None, forced_orientation=None):
    """Write gfx_src/<name>/.  Returns (folder, record) where record is what graphic.json holds."""
    if not NAME_RE.match(name or ""):
        fail(f"the graphic name must be lowercase letters, digits, - or _ (at most 40), not '{name}'.")
    if name.startswith("hit_") or name == "end_fade":
        fail(f"the name {name} is reserved; choose another.")
    known = templates()
    short = (template or "")[len(PREFIX):] if (template or "").startswith(PREFIX) else template
    if short not in known:
        fail(f"--template must be one of {', '.join(known)}" + (f", not '{template}'." if template else "."))
    meta = known[short]
    if not video_dir(main).is_dir():
        fail(f"the video folder {video_dir(main)} does not exist.")
    values = resolve_variables(meta, given, main)
    dur = check_duration(duration, meta, values)
    size = SIZES[orientation(main, forced_orientation)]
    src = Path(values["image"]) if values.get("image") else None
    image_name = f"photo{src.suffix.lower()}" if src else None
    page = render_page(meta, values, dur, size, image_name)
    record_vars = dict(values, image=image_name or "")
    gsrc = project_dir(main) / "gfx_src"
    gsrc.mkdir(parents=True, exist_ok=True)
    work = gsrc / f".{name}.new"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        with open(work / "index.html", "w", encoding="utf-8", newline="\n") as f:
            f.write(page)
        if src:
            shutil.copyfile(src, work / image_name)
        record = {"template": meta["id"], "name": name, "duration": dur, "width": size[0], "height": size[1],
                  "variables": record_vars}
        (work / "graphic.json").write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        final = gsrc / name
        if final.exists():
            shutil.rmtree(final)
        os.replace(work, final)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return final, record


def run(a):
    """The `graphic` command (ve.py cmd_graphic)."""
    if a.list:
        print("\n".join(list_lines()))
        return 0
    if not a.main or not a.name:
        fail("usage: ve.py graphic <video folder> <name> --template <template> [--var key=value ...] [--duration S]; "
             "ve.py graphic --list shows the templates.")
    if not a.template:
        fail("--template is required; ve.py graphic --list shows the templates.")
    folder, rec = build(a.main, a.name, a.template, parse_assignments(a.var), a.duration, a.orientation)
    print(f"graphic {a.name}: {rec['template']} {rec['width']}x{rec['height']} {rec['duration']:g}s -> {folder}")
    print(f'use it in timeline.py as a VIS entry "G:{a.name}"; ve.py gfx renders it.')
    return 0

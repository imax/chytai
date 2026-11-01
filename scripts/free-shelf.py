#!/usr/bin/env python3
"""Takes the wanted free books the site found (https://chytai.org.ua/free-ready.json) into the reader's
«Вільна полиця»: the EPUB into free/, its line into free/shelf.json and web/seed/free.json, its cover into
web/public/free-covers (Max, 2026-11-01: «додавати і слати мені імейл»; the site mails him after the deploy).
Run daily by .github/workflows/free-shelf.yml; prints the names it added. A file that is not an EPUB, or is
bigger than MAX_MB, is skipped. A book once in free/ (or taken out by hand, listed in free/skipped.json) is
not taken again."""
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.environ.get("SITE", "https://chytai.org.ua")
UA = "Chytai/1.0 (https://chytai.org.ua; free shelf)"
MAX_MB = 15
LIMIT = int(os.environ.get("LIMIT", "5"))  # a few a day, so a bad batch is small


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, data):
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def cover_of(epub):
    """The cover image's bytes, from the OPF's cover-image item or <meta name="cover">."""
    z = zipfile.ZipFile(io.BytesIO(epub))
    container = z.read("META-INF/container.xml").decode("utf-8", "replace")
    opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
    opf = z.read(opf_path).decode("utf-8", "replace")
    base = os.path.dirname(opf_path)
    items = {m.group(0): m for m in re.finditer(r"<item\b[^>]*>", opf)}
    attr = lambda tag, name: (re.search(rf'\b{name}="([^"]*)"', tag) or [None, None])[1]
    href = None
    for tag in items:
        if "cover-image" in (attr(tag, "properties") or ""):
            href = attr(tag, "href")
    if not href:
        m = re.search(r'<meta\b[^>]*name="cover"[^>]*>', opf)
        cid = m and attr(m.group(0), "content")
        for tag in items:
            if cid and attr(tag, "id") == cid:
                href = attr(tag, "href")
    if not href:
        return None
    return z.read(os.path.normpath(os.path.join(base, urllib.request.unquote(href))).replace(os.sep, "/"))


def main():
    ready = json.loads(get(f"{SITE}/free-ready.json", 60))
    shelf_path = os.path.join(ROOT, "free", "shelf.json")
    seed_path = os.path.join(ROOT, "web", "seed", "free.json")
    shelf = load(shelf_path, [])
    seed = load(seed_path, [])
    skipped = set(load(os.path.join(ROOT, "free", "skipped.json"), []))
    have = {f["name"] for f in shelf} | {f["name"] for f in seed} | set(os.listdir(os.path.join(ROOT, "free"))) | skipped
    added = []
    for x in ready:
        if len(added) >= LIMIT:
            break
        name = x["name"]
        if name in have or not re.fullmatch(r"[a-z0-9-]+\.epub", name):
            continue
        try:
            epub = get(x["epub"])
        except Exception as e:
            print(f"skip {name}: {e}", file=sys.stderr)
            continue
        if not epub.startswith(b"PK") or len(epub) > MAX_MB * 1024 * 1024:
            print(f"skip {name}: not an EPUB or too big ({len(epub)} bytes)", file=sys.stderr)
            continue
        try:
            zipfile.ZipFile(io.BytesIO(epub)).read("META-INF/container.xml")
        except Exception as e:
            print(f"skip {name}: broken EPUB ({e})", file=sys.stderr)
            continue
        with open(os.path.join(ROOT, "free", name), "wb") as f:
            f.write(epub)
        try:
            cover = cover_of(epub)
        except Exception:
            cover = None
        if cover:
            with open(os.path.join(ROOT, "web", "public", "free-covers", name[:-5] + ".jpg"), "wb") as f:
                f.write(cover)
        uk = x["lang"] == "uk"
        shelf.append({"name": name, "title": x["title"], "authors": [a.strip() for a in x["authors"].split(",") if a.strip()], "group": "Українська класика" if uk else "Англійською", "wanted": True, "source": x["page"]})
        seed.append({"name": name, "title": x["title"], "authors": x["authors"], "tags": ["Українська класика", "Українською"] if uk else ["Англійською"], "wanted": True, "source": x["page"]})
        have.add(name)
        added.append(name)
    if added:
        save(shelf_path, shelf)
        save(seed_path, seed)
    print("\n".join(added))


if __name__ == "__main__":
    main()

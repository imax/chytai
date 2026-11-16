"""A uk.wikisource text -> a clean EPUB for the reader's free shelf (Max, 2026-11-16: the school program's classics):
only the author's text, without the edition's title pages, notes, licence boxes, page numbers and menus.
1. Find an edition page in modern spelling (Wikisource's own search, /w/index.php?search=…; the API answers this
   container 429). A «Версії роботи» page is a list, not a text.
2. curl -G https://ws-export.wmcloud.org/ --data-urlencode format=epub-3 --data-urlencode lang=uk
   --data-urlencode "page=<edition page>" --data-urlencode images=false -o src.epub
3. python3 scripts/wsbook.py config.json, a list of {src, out, name, title, author, page, skip: [file index],
   titles: {index: title}, cut: {index: {start, end}}, noHeadings; for another EPUB `files`: its chapter files in
   order, `split`: a regex of headings to cut one file into chapters, `rename`: {heading: title}, `fix`: {typo: text},
   `tr`: a JSON file {source text: translation} matched per paragraph, longest first}; it prints each chapter's start and end to check.
4. free/<name>.epub, a line in free/shelf.json and web/seed/free.json, a cover in free/covers and
   web/public/free-covers (a public-domain painting with the title in a dark band, 1200×1800)."""
import json, re, sys, uuid, zipfile, html, warnings
import xml.etree.ElementTree as ET
from bs4 import XMLParsedAsHTMLWarning
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
from bs4 import BeautifulSoup, NavigableString, Comment

KEEP = {"p", "br", "i", "em", "b", "strong", "h1", "h2", "h3", "h4", "blockquote", "div", "small", "sup", "sub"}

def clean_body(s):
    soup = BeautifulSoup(s, "lxml")
    body = soup.body
    for el in body.find_all(["style", "script", "img", "figure", "table"]):
        el.decompose()
    for c in body.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    sel = [".pagenum", ".ws-pagenum", ".headertemplate", ".box_menu", "sup.reference", ".mw-references-wrap", "ol.references",
           ".references", ".licenseContainer", ".licenseBanner", ".mw-editsection", ".ws-noexport", ".noprint", ".navbox"]
    for q in sel:
        for el in body.select(q):
            el.decompose()
    # licence boxes and the like that carry no class we know
    for el in body.find_all(["div", "p"]):
        if getattr(el, "decomposed", False):
            continue
        t = el.get_text(" ", strip=True)
        if "суспільному надбанні" in t and len(t) < 1500:
            el.decompose()
    for el in body.find_all("div", style=re.compile(r"visibility:\s*hidden")):
        el.decompose()
    for el in body.find_all("sup"):
        if re.fullmatch(r"\s*[\d*]+\s*\)?\s*", el.get_text()):
            el.decompose()
    for a in body.find_all("a"):
        a.unwrap()
    for el in body.find_all(True):
        if el.name not in KEEP:
            el.unwrap()
            continue
        cls = el.get("class") or []
        style = el.get("style") or ""
        el.attrs = {}
        if "poem" in cls:
            el["class"] = "poem"
        elif re.search(r"text-align:\s*center", style):
            el["class"] = "center"
        elif re.search(r"text-align:\s*right", style):
            el["class"] = "right"
    out = body.decode_contents().replace("\u00ad", "")
    out = re.sub(r"(<br/?>\s*){3,}", "<br/><br/>", out)
    out = re.sub(r"<(p|div)( class=\"\w+\")?>\s*</\1>", "", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()

def text_of(h):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()

def cut(h, start=None, end=None):
    """Drop what comes before the first block containing `start` and from the block containing `end`."""
    if start:
        m = re.search(re.escape(start), h)
        if not m:
            raise SystemExit(f"start not found: {start}")
        i = max(h.rfind("<p", 0, m.start()), h.rfind("<div", 0, m.start()), h.rfind("<h", 0, m.start()))
        h = h[i if i >= 0 else m.start():]
    if end:
        m = re.search(re.escape(end), h)
        if not m:
            raise SystemExit(f"end not found: {end}")
        i = max(h.rfind("<p", 0, m.start()), h.rfind("<div", 0, m.start()))
        h = h[: i if i >= 0 else m.start()]
    # close what the cut left open
    return str(BeautifulSoup(f"<body>{h}</body>", "lxml").body.decode_contents())

XHTML = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="uk" lang="uk"><head><meta charset="UTF-8"/><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
{body}
</body></html>"""
CSS = """body{margin:0 5%;line-height:1.5}p{margin:0;text-indent:1.5em}h2{text-align:center;margin:1.5em 0 1em;text-indent:0}.center{text-align:center;text-indent:0}.right{text-align:right}.poem{margin:1em 0 1em 1.5em}.poem p{text-indent:0;text-align:left;hyphens:none;-webkit-hyphens:none}"""

def build(cfg):
    z = zipfile.ZipFile(cfg["src"])
    if cfg.get("files"):  # another EPUB (Max's finds on OpenBook): its chapter files in order
        files = cfg["files"]
    else:
        files = [n for n in z.namelist() if n.endswith(".xhtml") and not re.search(r"/(nav|title|about)\.xhtml$", n)]
        files.sort(key=lambda n: int(re.search(r"/c(\d+)_", n).group(1)))
    chapters = []
    for i, n in enumerate(files):
        if i in cfg.get("skip", []):
            continue
        raw = z.read(n).decode("utf8")
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", raw, re.S) if cfg.get("files") else None
        t = text_of(h1.group(1) if h1 else html.unescape(re.search(r"<title>(.*?)</title>", raw, re.S).group(1))).replace("\u00ad", "")
        if cfg.get("files"):  # Pages' «2 I ПОЛЬОВА ЦАРІВНА | Назва книжки»
            t = re.sub(r"^\d+\s+", "", t.split(" | ")[0])
        body = clean_body(raw)
        o = cfg.get("cut", {}).get(str(i))
        if o:
            body = cut(body, o.get("start"), o.get("end"))
        title = cfg.get("titles", {}).get(str(i)) or t
        if not text_of(body):
            continue
        if cfg.get("split"):  # one file of a whole play: a chapter from each block that is only «ДІЯ ДРУГА» and the like
            parts = re.split(r"(?=<(?:p|h\d)[^>]*>\s*(?:%s)\s*</(?:p|h\d)>)" % cfg["split"], body)
            for k, part in enumerate(parts):
                if text_of(part):
                    m = re.match(r"<(?:p|h\d)[^>]*>\s*(%s)\s*</(?:p|h\d)>" % cfg["split"], part)
                    if m:  # the heading as a heading, not a line of text
                        part = "<h2>%s</h2>" % m.group(1) + part[m.end():]
                    part = BeautifulSoup(part, "html.parser").decode()  # a cut through a <div> leaves it open
                    chapters.append((m.group(1) if m else title, part))
            continue
        chapters.append((title, body))
    chapters = [(cfg.get("rename", {}).get(t, t), b) for t, b in chapters]
    for old, new in cfg.get("fix", {}).items():  # the source's own typos («ДІЙОВЕ ЛЮДИ»)
        chapters = [(t.replace(old, new), b.replace(old, new)) for t, b in chapters]
    if cfg.get("tr"):  # stage directions translated, {source text: text}, matched per paragraph (Max 2026-11-16:
        tr = json.load(open(cfg["tr"]))  # Kvitka's Russian stage directions in Ukrainian, his lines as they are)
        keys = sorted(tr, key=len, reverse=True)
        used = set()
        def one(m):
            inner = re.sub(r"\s+", " ", m.group(3)).strip()
            for k in keys:
                if k in inner:
                    inner = inner.replace(k, tr[k]); used.add(k)
            return "<%s%s>%s</%s>" % (m.group(1), m.group(2) or "", inner, m.group(1))
        chapters = [(tr.get(t, t), re.sub(r"<(p|h\d)( [^>]*)?>(.*?)</\1>", one, b, flags=re.S)) for t, b in chapters]
        for k in keys:
            if k not in used:
                print("   tr: not found:", k[:80])
    name = cfg["name"]
    uid = uuid.uuid5(uuid.NAMESPACE_URL, "https://chytai.org.ua/free/" + name)
    with zipfile.ZipFile(cfg["out"], "w") as o:
        o.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        o.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', compress_type=zipfile.ZIP_DEFLATED)
        man, spine, nav = [], [], []
        for k, (t, b) in enumerate(chapters, 1):
            f = f"c{k:02d}.xhtml"
            head = "" if cfg.get("noHeadings") else f"<h2>{html.escape(t)}</h2>\n"
            page = XHTML.format(title=html.escape(t), body=head + b)
            ET.fromstring(page.split("?>", 1)[1].replace("<!DOCTYPE html>", ""))  # the reader shows an XML error for a bad page
            o.writestr("OEBPS/" + f, page, compress_type=zipfile.ZIP_DEFLATED)
            man.append(f'<item id="c{k}" href="{f}" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{k}"/>')
            nav.append(f'<li><a href="{f}">{html.escape(t)}</a></li>')
        o.writestr("OEBPS/style.css", CSS, compress_type=zipfile.ZIP_DEFLATED)
        o.writestr("OEBPS/nav.xhtml", XHTML.replace('<link rel="stylesheet" type="text/css" href="style.css"/>', "").replace("<html ", '<html xmlns:epub="http://www.idpf.org/2007/ops" ').format(title="Зміст", body=f'<nav epub:type="toc"><h1>Зміст</h1><ol>{"".join(nav)}</ol></nav>'), compress_type=zipfile.ZIP_DEFLATED)
        opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="uk">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:{uid}</dc:identifier><dc:title>{html.escape(cfg["title"])}</dc:title><dc:creator>{html.escape(cfg["author"])}</dc:creator><dc:language>uk</dc:language><dc:source>{html.escape(cfg["page"])}</dc:source><meta property="dcterms:modified">2026-11-16T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>{"".join(man)}</manifest>
<spine>{"".join(spine)}</spine></package>"""
        o.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
    total = sum(len(text_of(b)) for _, b in chapters)
    print(name, len(chapters), "chapters", total, "chars")
    for t, b in chapters:
        x = text_of(b)
        print(f"   [{t}] {x[:120]} … {x[-80:]}")

if __name__ == "__main__":
    for cfg in json.load(open(sys.argv[1])):
        build(cfg)

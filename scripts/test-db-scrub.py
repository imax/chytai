# Makes a test copy of the site's database (chytai-web) from a backup, for threads and the Mac to test on
# real data (Max, 2026-10-25). Run by .github/workflows/backup.yml after the nightly backup; the result is
# encrypted and published as the release asset "test-db" (see scripts/fetch-test-db.sh).
#   python3 test-db-scrub.py <backup chytai.db> <out test.db>
# What goes: real emails (each becomes <reader id>@test.invalid, so logging in by code still works: without
# RESEND_API_KEY the code goes to the log), sessions, login codes, MCP/OAuth clients, grants and tokens,
# secrets in meta, where readers came from. VACUUM at the end, so nothing deleted stays in free pages.
# Usernames, names, shelves, ratings and notes stay: they are on the public site anyway.
import re, shutil, sqlite3, sys
from datetime import datetime, timezone

src, out = sys.argv[1:3]
shutil.copyfile(src, out)
db = sqlite3.connect(out)
tables = {t for (t,) in db.execute("select name from sqlite_master where type='table'")}

# claude:key, ticket_key, digest:secret, reader:secret and any later one named the same way.
SECRET_META = re.compile(r"(^|[:_])(secret|key|token|password)s?$", re.I)

for t in ["sessions", "login_codes", "oauth_clients", "oauth_grants", "oauth_tokens"]:
    if t in tables:
        db.execute(f'delete from "{t}"')

cols = {c[1] for c in db.execute("pragma table_info(readers)")}
db.execute("update readers set email = id || '@test.invalid' where email is not null")
if "came" in cols:
    db.execute("update readers set came = null")

for (key,) in db.execute("select key from meta").fetchall():
    if SECRET_META.search(key):
        db.execute("delete from meta where key = ?", (key,))
# Mail logs, notes and the like may hold an address inside their text: swap any that is left outside the
# catalog (shops' and publishers' addresses in items/books are public).
CATALOG = {"items", "shelves", "books", "library_cache", "slugs", "advice", "overview", "reviews"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
db.create_function("scrub", 1, lambda v: EMAIL.sub(lambda m: m[0] if m[0].endswith("@test.invalid") else "someone@test.invalid", v) if isinstance(v, str) else v)
people = sorted(t for t in tables - CATALOG if not t.startswith("search"))
for t in people:
    for c in [c[1] for c in db.execute(f'pragma table_info("{t}")')]:
        db.execute(f'update or ignore "{t}" set "{c}" = scrub("{c}") where typeof("{c}") = \'text\' and "{c}" like \'%@%\'')

db.execute("insert or replace into meta (key, value) values ('testdb:made', ?)", (datetime.now(timezone.utc).isoformat(timespec="seconds"),))
db.commit()

# Check: nothing that looks like a person's address is left.
left = []
for t in people:
    for c in [c[1] for c in db.execute(f'pragma table_info("{t}")')]:
        for (v,) in db.execute(f'select "{c}" from "{t}" where typeof("{c}") = \'text\''):
            for m in EMAIL.findall(v):
                if not m.endswith("@test.invalid"):
                    left.append(f"{t}.{c}: {m}")
if left:
    print("addresses left:", *left[:20], sep="\n  ")
    sys.exit(1)

db.execute("vacuum")
db.close()
db = sqlite3.connect(out)
print(out, db.execute("pragma integrity_check").fetchone()[0],
      {t: db.execute(f'select count(*) from "{t}"').fetchone()[0] for t in ["readers", "entries", "books", "items", "sessions"] if t in tables})

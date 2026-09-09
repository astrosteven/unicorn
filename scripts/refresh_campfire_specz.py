#!/usr/bin/env python3
"""
refresh_campfire_specz.py  --  build per-field campfire spec-z sidecars for the UNICORN site.

Campfire (campfire.hollisakins.com) holds NIRCam spectroscopic redshifts for objects that
overlap several UNICORN fields (CEERS/EGS, COSMOS, ...). This standalone helper pulls the
campfire spec-z catalog, positionally cross-matches it against each UNICORN field's *already
published* search index (which carries id/ra/dec for every object -- so we touch NO FITS,
no braize mount, and none of the IDL pipeline), and writes a small sidecar per field:

    public/searchindex/<prefix>_specz_v<ver>.json

    { "field","version","radius_arcsec","source","n_matched",
      "objects": { "<obj_id>": {"z":<zspec>,"q":<quality>,"cid":<campfire_id>,"sep":<arcsec>}, ... } }

The sidecar is tiny (only objects with a spectrum) and only changes when campfire changes, so a
daily job can commit it without rebaking the multi-MB search indexes.

Typical use:
    # once recon fills in fetch_campfire_catalog(): pull live + write sidecars
    CAMPFIRE_USER=unicorn CAMPFIRE_PASS=... python3 refresh_campfire_specz.py

    # test the cross-match against a pre-dumped catalog, without hitting campfire:
    python3 refresh_campfire_specz.py --catalog campfire_dump.csv --dry-run
"""
import argparse, csv, glob, gzip, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _default_indexdir():
    """Locate public/searchindex whether this script sits in Website/scripts/ (dev) or
    unicorn/scripts/ (in-repo / CI)."""
    for c in (os.path.join(HERE, "..", "unicorn", "public", "searchindex"),  # Website/scripts
              os.path.join(HERE, "..", "public", "searchindex"),             # unicorn/scripts
              os.path.join(os.getcwd(), "public", "searchindex")):           # repo root (CI cwd)
        if os.path.isdir(c):
            return os.path.normpath(c)
    return os.path.normpath(os.path.join(HERE, "..", "unicorn", "public", "searchindex"))


DEFAULT_INDEXDIR = _default_indexdir()


# ---------------------------------------------------------------------------
# 1. Campfire catalog source
# ---------------------------------------------------------------------------
def load_catalog_file(path):
    """Load a pre-dumped campfire catalog (CSV or JSON) into a list of dicts with
    keys id, ra, dec, z, q.  Used for --catalog (testing / manual refresh)."""
    with open(path, "r") as f:
        head = f.read(1)
        f.seek(0)
        if head == "[" or head == "{":            # JSON
            data = json.load(f)
            rows = data.get("objects", data) if isinstance(data, dict) else data
        else:                                       # CSV
            rows = list(csv.DictReader(f))
    return [_norm_row(r) for r in rows]


# column-name aliases -> canonical (case-insensitive). campfire's `objects` table uses
# object_id / field / ra / dec / redshift / redshift_quality.
_ALIASES = {
    "id":  ["object_id", "id", "cid", "campfire_id", "objid", "name"],
    "cf":  ["field", "cf", "mosaic"],
    "ra":  ["ra", "ra_deg", "alpha", "alpha_j2000"],
    "dec": ["dec", "de", "dec_deg", "delta", "delta_j2000"],
    "z":   ["redshift", "z", "zspec", "z_spec", "z_best"],
    "q":   ["redshift_quality", "q", "quality", "z_quality", "qflag"],
}
# campfire redshift_quality decode (from their client JS)
QUALITY = {0: "Not Inspected", 1: "Impossible", 2: "Tentative", 3: "Probable", 4: "Secure"}


def _pick(row, keys):
    low = {k.lower(): v for k, v in row.items()}
    for k in keys:
        if k in low and low[k] not in ("", None):
            return low[k]
    return None


def _norm_row(row):
    def num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None
    q = _pick(row, _ALIASES["q"])
    try:
        q = int(float(q)) if q is not None else None
    except (TypeError, ValueError):
        pass
    return {
        "id":  _pick(row, _ALIASES["id"]),
        "cf":  _pick(row, _ALIASES["cf"]),     # campfire field, for the deep-link
        "ra":  num(_pick(row, _ALIASES["ra"])),
        "dec": num(_pick(row, _ALIASES["dec"])),
        "z":   num(_pick(row, _ALIASES["z"])),
        "q":   q,
    }


# campfire's public Supabase (anon key is baked into their client JS -- NOT a secret; the
# `objects` table is world-readable via RLS, so no login is needed).
CAMPFIRE_URL = "https://puyczxwyuzpnqvpachip.supabase.co"
CAMPFIRE_ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
                 "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1eWN6eHd5dXpwbnF2cGFjaGlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyMjMxODAsImV4cCI6MjA3Njc5OTE4MH0."
                 "o6iXMir99WyzcPs7HpjEL2vtwxavqNZ-kJVYSF6HCx0")
CAMPFIRE_COLS = "object_id,field,ra,dec,redshift,redshift_quality,photo_z,n_spectra"
PAGE = 5000


def fetch_campfire_catalog():
    """Pull the live campfire spec-z catalog from its public Supabase PostgREST endpoint
    (anon key, no login). Paginates via Range headers. Returns [{id,cf,ra,dec,z,q}, ...]."""
    import urllib.request
    base = (f"{CAMPFIRE_URL}/rest/v1/objects?select={CAMPFIRE_COLS}"
            f"&redshift=not.is.null&order=id.asc")
    rows, off = [], 0
    while True:
        req = urllib.request.Request(base, headers={
            "apikey": CAMPFIRE_ANON, "Authorization": f"Bearer {CAMPFIRE_ANON}",
            "Accept": "application/json", "Range": f"{off}-{off + PAGE - 1}",
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.load(r)
        rows.extend(page)
        if len(page) < PAGE:
            break
        off += PAGE
    return [_norm_row(r) for r in rows]


# ---------------------------------------------------------------------------
# 2. UNICORN index loading + cross-match
# ---------------------------------------------------------------------------
def load_index(path):
    raw = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    j = json.loads(raw)
    return j


def _radec_to_unit(ra_deg, dec_deg):
    import numpy as np
    ra = np.radians(np.asarray(ra_deg, float))
    dec = np.radians(np.asarray(dec_deg, float))
    cd = np.cos(dec)
    return np.column_stack([cd * np.cos(ra), cd * np.sin(ra), np.sin(dec)])


def crossmatch(idx, cat, radius_arcsec):
    """Nearest campfire source within radius for each UNICORN object. Returns
    {obj_id_str: {"z","q","cid","sep"}}.  Uses 3D unit-vector KD-tree (pole-safe)."""
    import numpy as np
    from scipy.spatial import cKDTree

    cat = [c for c in cat if c["ra"] is not None and c["dec"] is not None]
    if not cat:
        return {}
    cxyz = _radec_to_unit([c["ra"] for c in cat], [c["dec"] for c in cat])
    tree = cKDTree(cxyz)

    uxyz = _radec_to_unit(idx["ra"], idx["dec"])
    # chord length for a given angular sep: 2*sin(theta/2)
    chord = 2.0 * np.sin(np.radians(radius_arcsec / 3600.0) / 2.0)
    dist, who = tree.query(uxyz, k=1, distance_upper_bound=chord)

    ids = idx["id"]
    out = {}
    for i, (d, j) in enumerate(zip(dist, who)):
        if not np.isfinite(d) or j >= len(cat):
            continue
        sep = 2.0 * np.degrees(np.arcsin(min(d / 2.0, 1.0))) * 3600.0  # chord -> arcsec
        c = cat[j]
        out[str(ids[i])] = {
            "z":   round(c["z"], 4) if c["z"] is not None else None,
            "q":   c["q"],          # int 0-4; see QUALITY. site defaults to showing q>=3
            "cid": c["id"],         # campfire object_id, for ?search=
            "cf":  c["cf"],         # campfire field, for /nircam/<cf>
            "sep": round(float(sep), 3),
        }
    return out


# ---------------------------------------------------------------------------
# 3. Driver
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--indexdir", default=DEFAULT_INDEXDIR,
                    help="dir with <prefix>_search_v<ver>.json[.gz] (default: unicorn/public/searchindex)")
    ap.add_argument("--catalog", help="pre-dumped campfire catalog (CSV/JSON) instead of a live pull")
    ap.add_argument("--radius-arcsec", type=float, default=0.4, help="match radius (default 0.4\")")
    ap.add_argument("--only", help="comma-separated prefixes to limit to (e.g. ceers,egs,cosmos)")
    ap.add_argument("--dry-run", action="store_true", help="report match counts, write nothing")
    args = ap.parse_args()

    src = args.catalog or "campfire(live)"
    cat = load_catalog_file(args.catalog) if args.catalog else fetch_campfire_catalog()
    good = [c for c in cat if c["ra"] is not None and c["dec"] is not None and c["z"] is not None]
    print(f"campfire catalog: {len(cat)} rows ({len(good)} with ra/dec/z)  source={src}")

    indexes = sorted(glob.glob(os.path.join(args.indexdir, "*_search_v*.json.gz")) +
                     [p for p in glob.glob(os.path.join(args.indexdir, "*_search_v*.json"))
                      if not p.endswith(".gz")])
    only = set(args.only.split(",")) if args.only else None

    total = 0
    for path in indexes:
        m = re.search(r"([a-z0-9]+)_search_v([0-9.]+)\.json", os.path.basename(path))
        if not m:
            continue
        prefix, ver = m.group(1), m.group(2)
        if only and prefix not in only:
            continue
        idx = load_index(path)
        matched = crossmatch(idx, cat, args.radius_arcsec)
        total += len(matched)
        print(f"  {prefix:14s} v{ver:6s}  {idx['n']:>7d} objs  ->  {len(matched):>5d} spec-z matched")
        if args.dry_run:
            continue
        out = {
            "field": idx.get("field", prefix), "version": ver,
            "radius_arcsec": args.radius_arcsec, "source": "campfire",
            "n_matched": len(matched), "objects": matched,
        }
        # gzip only, matching the search-index convention (the site gunzips in-browser)
        payload = json.dumps(out, separators=(",", ":")).encode()
        outpath = os.path.join(args.indexdir, f"{prefix}_specz_v{ver}.json.gz")
        with open(outpath, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as f:  # mtime=0 -> stable bytes
                f.write(payload)
        print(f"                 wrote {os.path.relpath(outpath)}  ({os.path.getsize(outpath)/1024:.1f} KB gz)")

    print(f"total spec-z matches across fields: {total}"
          + ("   [dry-run: no files written]" if args.dry_run else ""))


if __name__ == "__main__":
    main()

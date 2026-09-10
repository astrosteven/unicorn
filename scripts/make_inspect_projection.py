#!/usr/bin/env python3
"""
make_inspect_projection.py -- project the web visual-inspection decisions (Supabase
`inspections` table) into TWO artifacts:

  (A) WEB de-select override, per field:
        public/searchindex/<prefix>_inspect_v<ver>.json
        = {"field","version","removed":[ids],"kept":[ids],"n":N}
      The site (objectCard.loadField) applies `removed` -> selected=0 at load, so an
      object flagged "Remove" drops out of the SELECTED sample everywhere (search
      `selected=1`, map colour, the star badge, the inspector) WITHOUT re-uploading
      the big published index. Nothing is deleted from the catalog.

  (B) doselect input, per field:
        <out>/<prefix>_inspection_notes_v<ver>.json
      A SPARSE list of {lastModified, decision, notes, id(UUID), galaxyObjectID} in the
      exact schema unicorn_doselect.pro's cleanfile expects (decision 'Keep'->inspect=1,
      'Remove'->inspect=0, matched by galaxyObjectID == catalog id). Drop this in each
      field's selection/ dir and rerun doselect to bake the flag into selected.fits.

Decisions are position-matched (ra/dec) to the CURRENT published index ids, so they stay
valid across catalog versions (obj_ids can renumber). Latest decision per object wins.

This is a STANDALONE read-only helper: it READS the Supabase table + the local index
sidecars and WRITES only the two artifacts above. It never touches source data or IDL.

Auth: needs a Supabase key that can read `inspections` (RLS is authenticated-only), so
use the service_role key. Provide it via env — never hard-code / commit it:

  export SUPABASE_URL=https://nutjfdfklbetjzbtulbv.supabase.co   # (default; optional)
  export SUPABASE_SERVICE_KEY=<service_role key from Dashboard -> Settings -> API>
  python3 scripts/make_inspect_projection.py                     # all fields
  python3 scripts/make_inspect_projection.py --field CEERS       # one field
"""
import argparse, glob, gzip, json, os, sys, time, urllib.request, urllib.error, uuid

import numpy as np


def _unit(ra, dec):
    """(ra,dec) deg -> unit vector(s) on the sphere."""
    r = np.radians(ra); d = np.radians(dec)
    return np.stack([np.cos(d) * np.cos(r), np.cos(d) * np.sin(r), np.sin(d)], axis=-1)

HERE = os.path.dirname(os.path.abspath(__file__))
INDEXDIR = os.path.normpath(os.path.join(HERE, "..", "public", "searchindex"))
# Seconds between the Unix epoch (1970-01-01) and the Cocoa/NSDate epoch (2001-01-01);
# the desktop inspector stored lastModified as time-since-2001, so we match that.
COCOA_EPOCH = 978307200
DEFAULT_URL = "https://nutjfdfklbetjzbtulbv.supabase.co"
MATCH_TOL_ARCSEC = 0.30   # ra/dec cross-match radius to the current index


def load_index(path):
    """Load a *_search_v*.json[.gz] index -> (field_name, prefix, version, ra, dec, id)."""
    fn = os.path.basename(path)
    # <prefix>_search_v<ver>.json[.gz]
    stem = fn.replace(".json.gz", "").replace(".json", "")
    prefix = stem.split("_search_v")[0]
    version = stem.split("_search_v")[1]
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt") as f:
        d = json.load(f)
    field = d.get("field", prefix)
    ra = np.asarray(d["ra"], dtype=float)
    dec = np.asarray(d["dec"], dtype=float)
    ids = np.asarray(d["id"])
    return field, prefix, version, ra, dec, ids


def discover_indexes():
    """field_name -> dict(prefix, version, id, xyz) for every published index."""
    out = {}
    for path in sorted(glob.glob(os.path.join(INDEXDIR, "*_search_v*.json*"))):
        if path.endswith(".json") and os.path.exists(path + ".gz"):
            continue  # prefer the .gz if both exist
        field, prefix, version, ra, dec, ids = load_index(path)
        out[field] = dict(prefix=prefix, version=version, id=ids, xyz=_unit(ra, dec))
    return out


def fetch_inspections(url, key):
    """Pull the whole `inspections` table via PostgREST, paginated by Range header."""
    rows, step, start = [], 1000, 0
    base = f"{url.rstrip('/')}/rest/v1/inspections?select=*"
    while True:
        req = urllib.request.Request(base, headers={
            "apikey": key, "Authorization": f"Bearer {key}",
            "Range-Unit": "items", "Range": f"{start}-{start + step - 1}",
        })
        try:
            with urllib.request.urlopen(req) as resp:
                chunk = json.load(resp)
        except urllib.error.HTTPError as e:
            sys.exit(f"ERROR pulling inspections: HTTP {e.code} {e.read().decode()[:300]}")
        if not chunk:
            break
        rows.extend(chunk)
        if len(chunk) < step:
            break
        start += step
    return rows


def match_id(field_idx, ra, dec):
    """Nearest current-index id within MATCH_TOL_ARCSEC, or None. Brute-force cosine
    nearest neighbour on unit vectors — the inspection set is small, so this is fast
    and needs no scipy."""
    if ra is None or dec is None:
        return None
    v = _unit(float(ra), float(dec))                 # (3,)
    cos = field_idx["xyz"] @ v                        # (N,)  dot = cos(sep)
    k = int(np.argmax(cos))
    sep_arcsec = np.degrees(np.arccos(np.clip(cos[k], -1.0, 1.0))) * 3600.0
    if sep_arcsec > MATCH_TOL_ARCSEC:
        return None
    return field_idx["id"][k]


# Site decision -> doselect decision string. not_inspected is dropped entirely.
DEC_MAP = {"keep": "Keep", "remove": "Remove", "undecided": "Undecided"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--field", help="restrict to one field NAME (e.g. CEERS); default all")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "inspection_export"),
                    help="dir for the doselect *_inspection_notes_v<ver>.json files")
    ap.add_argument("--url", default=os.environ.get("SUPABASE_URL", DEFAULT_URL))
    ap.add_argument("--key", default=os.environ.get("SUPABASE_SERVICE_KEY")
                    or os.environ.get("SUPABASE_KEY"))
    args = ap.parse_args()
    if not args.key:
        sys.exit("ERROR: set SUPABASE_SERVICE_KEY (service_role key) in the environment.")

    indexes = discover_indexes()
    rows = fetch_inspections(args.url, args.key)
    print(f"pulled {len(rows)} inspection rows; {len(indexes)} published indexes")

    # Group rows by field; keep the LATEST decision per (field, matched id).
    outdir = os.path.normpath(args.out)
    os.makedirs(outdir, exist_ok=True)

    by_field = {}
    for r in rows:
        by_field.setdefault(r.get("field"), []).append(r)

    for field, frows in sorted(by_field.items()):
        if args.field and field != args.field:
            continue
        if field not in indexes:
            print(f"  [skip] {field}: no published index in {INDEXDIR}")
            continue
        fi = indexes[field]
        # matched id -> (lastModified, decision, notes)
        latest = {}
        unmatched = 0
        for r in frows:
            dec = DEC_MAP.get((r.get("decision") or "").lower())
            if dec is None:
                continue  # not_inspected / unknown
            mid = match_id(fi, r.get("ra"), r.get("dec"))
            if mid is None:
                # fall back to obj_id when the row predates position storage
                oid = r.get("obj_id")
                if oid is not None and oid in set(fi["id"].tolist()):
                    mid = oid
                else:
                    unmatched += 1
                    continue
            # timestamp -> seconds since 2001 (best-effort; decision is what matters)
            ts = r.get("updated_at") or r.get("created_at")
            lm = _parse_ts(ts)
            key = int(mid) if str(mid).lstrip("-").isdigit() else mid
            prev = latest.get(key)
            if prev is None or lm >= prev[0]:
                latest[key] = (lm, dec, r.get("notes") or "")

        removed = sorted(int(k) for k, v in latest.items() if v[1] == "Remove")
        kept = sorted(int(k) for k, v in latest.items() if v[1] == "Keep")

        # (A) web override
        web = {"field": field, "version": fi["version"], "n": len(latest),
               "removed": removed, "kept": kept}
        web_path = os.path.join(INDEXDIR, f"{fi['prefix']}_inspect_v{fi['version']}.json")
        with open(web_path, "w") as f:
            json.dump(web, f, separators=(",", ":"))

        # (B) doselect sparse notes list
        notes = [{
            "lastModified": lm,
            "decision": dec,
            "notes": nt,
            "id": str(uuid.uuid4()).upper(),
            "galaxyObjectID": str(k),
        } for k, (lm, dec, nt) in sorted(latest.items())]
        ds_path = os.path.join(outdir, f"{fi['prefix']}_inspection_notes_v{fi['version']}.json")
        with open(ds_path, "w") as f:
            json.dump(notes, f, indent=1)

        print(f"  {field}: {len(latest)} inspected ({len(removed)} remove, {len(kept)} keep, "
              f"{len(latest)-len(removed)-len(kept)} undecided; {unmatched} unmatched)")
        print(f"      web:      {os.path.relpath(web_path)}")
        print(f"      doselect: {ds_path}")


def _parse_ts(ts):
    """ISO8601 (Supabase) -> seconds since 2001, else now-2001."""
    if ts:
        try:
            # e.g. 2026-09-09T18:22:05.123456+00:00
            from datetime import datetime
            s = ts.replace("Z", "+00:00")
            return datetime.fromisoformat(s).timestamp() - COCOA_EPOCH
        except Exception:
            pass
    return time.time() - COCOA_EPOCH


if __name__ == "__main__":
    main()

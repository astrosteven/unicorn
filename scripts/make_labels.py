#!/usr/bin/env python3
"""
make_labels.py  --  resolve a curated list of famous named objects (Maisie's Galaxy,
GN-z11, JADES-GS-z14-0, ...) to each UNICORN field's CURRENT catalog id BY POSITION,
and write public/searchindex/labels.json for the site's "By Name" search + label badge.

Position-keyed (not ID-keyed), so it survives catalog re-versioning: re-run after a
version bump and every name re-resolves to the new id. Standalone helper (not IDL);
reads only the published search indexes (id/ra/dec), touches no FITS/pipeline.

Input: a JSON array of objects with at least name + ra + dec, e.g.
  [{"name":"Maisie's Galaxy","aka":["Maisie"],"field":"CEERS","ra":214.9,"dec":52.9,
    "z":11.44,"z_type":"spec","ref":"Finkelstein+2023","note":"..."}]

Usage:
  python3 make_labels.py --input named_objects.json            # -> searchindex/labels.json
  python3 make_labels.py --input named_objects.json --tol 1.0 --dry-run
"""
import argparse, glob, gzip, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
def _default_indexdir():
    for c in (os.path.join(HERE, "..", "unicorn", "public", "searchindex"),
              os.path.join(HERE, "..", "public", "searchindex"),
              os.path.join(os.getcwd(), "public", "searchindex")):
        if os.path.isdir(c):
            return os.path.normpath(c)
    return os.path.normpath(os.path.join(HERE, "..", "public", "searchindex"))

# search-index prefix -> the field name the site uses (SEARCH_FIELDS[].field)
PREFIX_FIELD = {
    "ceers": "CEERS", "goodss": "GOODS-S", "goodsn": "GOODS-N", "a2744": "A2744",
    "ngdeep": "NGDEEP", "egs": "EGS", "primercosmos": "PRIMER-COSMOS",
    "primeruds": "PRIMER-UDS", "cosmos": "COSMOS",
}


def load_index(path):
    raw = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    return json.loads(raw)


def _unit(ra, dec):
    import numpy as np
    ra = np.radians(np.asarray(ra, float)); dec = np.radians(np.asarray(dec, float))
    cd = np.cos(dec)
    return np.column_stack([cd * np.cos(ra), cd * np.sin(ra), np.sin(dec)])


def main():
    import numpy as np
    from scipy.spatial import cKDTree
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="curated named-objects JSON (array)")
    ap.add_argument("--indexdir", default=_default_indexdir())
    ap.add_argument("--tol", type=float, default=1.0, help="match radius arcsec (literature coords are coarse; default 1.0)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    named = json.load(open(args.input))
    if isinstance(named, dict):
        named = named.get("labels", named.get("objects", []))

    # Build a KD-tree per field once.
    trees = {}
    for path in sorted(glob.glob(os.path.join(args.indexdir, "*_search_v*.json.gz"))):
        m = re.search(r"([a-z0-9]+)_search_v([0-9.]+)\.json", os.path.basename(path))
        if not m or m.group(1) not in PREFIX_FIELD:
            continue
        prefix = m.group(1)
        idx = load_index(path)
        trees[prefix] = (idx, cKDTree(_unit(idx["ra"], idx["dec"])))

    chord = 2.0 * np.sin(np.radians(args.tol / 3600.0) / 2.0)
    out, unresolved = [], []
    for obj in named:
        ra, dec = obj.get("ra"), obj.get("dec")
        if ra is None or dec is None:
            unresolved.append((obj.get("name"), "no coords"))
            continue
        v = _unit([ra], [dec])
        # Emit a label for EVERY field that detects the object within tol — overlapping
        # fields (COSMOS/PRIMER-COSMOS, CEERS/EGS) both cover the same sky, so a famous
        # object should flag in each catalog it appears in, not just the nearest.
        matches = []  # (sep, prefix, id)
        for prefix, (idx, tree) in trees.items():
            d, j = tree.query(v, k=1, distance_upper_bound=chord)
            d, j = float(d[0]), int(j[0])
            if not np.isfinite(d) or j >= len(idx["id"]):
                continue
            sep = 2.0 * np.degrees(np.arcsin(min(d / 2.0, 1.0))) * 3600.0
            matches.append((sep, prefix, int(idx["id"][j])))
        if not matches:
            unresolved.append((obj.get("name"), f"no object within {args.tol}\""))
            continue
        matches.sort()
        for sep, prefix, oid in matches:
            rec = {"name": obj["name"], "field": PREFIX_FIELD[prefix], "id": oid,
                   "ra": ra, "dec": dec, "sep": round(sep, 3)}
            for k in ("aka", "z", "z_type", "ref", "note"):
                if obj.get(k) not in (None, "", []):
                    rec[k] = obj[k]
            out.append(rec)
        print(f"  {obj['name']:26s} -> " +
              ", ".join(f"{PREFIX_FIELD[p]}:{oid}({s:.2f}\")" for s, p, oid in matches))

    print(f"\nresolved {len(out)}/{len(named)} named objects")
    for name, why in unresolved:
        print(f"  UNRESOLVED: {name} — {why}")

    if args.dry_run:
        print("[dry-run: labels.json not written]")
        return
    payload = {"version": 1, "labels": out}
    outpath = os.path.join(args.indexdir, "labels.json")
    with open(outpath, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {os.path.relpath(outpath)}  ({len(out)} labels, {os.path.getsize(outpath)} bytes)")


if __name__ == "__main__":
    main()

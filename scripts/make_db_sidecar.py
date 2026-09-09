#!/usr/bin/env python3
"""
make_db_sidecar.py -- pull dense-basis physical properties from a *_DB_v<ver>.fits into a
per-field sidecar the site loads lazily and exposes as queryable columns.

Currently CEERS only. The DB table is ROW-ALIGNED to the published search index (src_id ==
index id, same order), so we emit parallel arrays aligned to index order (like the _filters
file), keyed by the site's query-column names:

  mass/mass_16/mass_84  <- mass_50/mass_16/mass_84   (log10 Msun)
  av/av_16/av_84        <- av_50/av_16/av_84          (mag)
  sfr10/sfr10_16/_84    <- sfr10_50/sfr10_16/_84      (log10 Msun/yr, 10 Myr)
  sfr100/sfr100_16/_84  <- sfr100_50/sfr100_16/_84    (log10 Msun/yr, 100 Myr)

Writes public/searchindex/<prefix>_db_v<ver>.json.gz.  Standalone helper (not IDL).

Usage: python3 make_db_sidecar.py --db <ceers_DB_v0.98.fits> --prefix ceers --version 0.98
"""
import argparse, gzip, json, os
import numpy as np
from astropy.io import fits

HERE = os.path.dirname(os.path.abspath(__file__))
DEF_INDEXDIR = os.path.normpath(os.path.join(HERE, "..", "public", "searchindex"))

# query-column name  <-  DB FITS column
COLS = {
    "mass": "mass_50", "mass_16": "mass_16", "mass_84": "mass_84",
    "av": "av_50", "av_16": "av_16", "av_84": "av_84",
    "sfr10": "sfr10_50", "sfr10_16": "sfr10_16", "sfr10_84": "sfr10_84",
    "sfr100": "sfr100_50", "sfr100_16": "sfr100_16", "sfr100_84": "sfr100_84",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--indexdir", default=DEF_INDEXDIR)
    ap.add_argument("--ndp", type=int, default=3, help="decimals to round to")
    args = ap.parse_args()

    db = fits.open(args.db)[1].data
    sid = np.asarray(db["src_id"])

    # sanity: row-aligned to the index?
    idxpath = os.path.join(args.indexdir, f"{args.prefix}_search_v{args.version}.json.gz")
    idx = json.loads(gzip.open(idxpath, "rt").read())
    iid = np.asarray(idx["id"])
    if not (len(sid) == len(iid) and np.array_equal(sid, iid)):
        raise SystemExit(f"ERROR: {args.db} src_id is NOT row-aligned to {os.path.basename(idxpath)} "
                         "— need an id-based join (not implemented).")

    def clean(col):
        a = np.asarray(db[col], dtype=float)
        out = []
        for v in a:
            out.append(None if not np.isfinite(v) else round(float(v), args.ndp))
        return out

    obj = {qname: clean(dbcol) for qname, dbcol in COLS.items()}
    payload = {"field": idx.get("field", args.prefix), "version": args.version,
               "columns": list(COLS.keys()), "n": len(iid), **obj}

    outpath = os.path.join(args.indexdir, f"{args.prefix}_db_v{args.version}.json.gz")
    data = json.dumps(payload, separators=(",", ":")).encode()
    with open(outpath, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as f:
            f.write(data)
    nfinite = sum(1 for v in obj["mass"] if v is not None)
    print(f"wrote {os.path.relpath(outpath)}  ({len(iid)} rows, {nfinite} with mass, "
          f"{len(COLS)} cols, {os.path.getsize(outpath)/1e6:.1f} MB gz)")


if __name__ == "__main__":
    main()

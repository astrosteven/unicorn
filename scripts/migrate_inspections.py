#!/usr/bin/env python3
"""
migrate_inspections.py  --  Re-key Supabase `inspections` rows to the v0.99 object IDs
after the v0.99 re-reduction renumbered sources in 5 fields.

Source IDs changed at v0.99 in GOODS-S, A2744, COSMOS, PRIMER-COSMOS, PRIMER-UDS (CEERS,
EGS, GOODS-N were stable). `inspections` is keyed by (field, obj_id) with no catalog
version, so decisions made against the old catalogs now point at the WRONG v0.99 object.
Each row stores ra/dec, so we cross-match each decision's position to the nearest v0.99
object in that field's search index and re-key it to the new obj_id.

For each affected row:
  new_id = nearest v0.99 object to (ra, dec), within --tol arcsec
  if new_id != old obj_id:  DELETE old row, UPSERT row at new_id (version -> 0.99,
                            decision/notes/inspector/ra/dec preserved)
Rows already matching, or with no object within tol (orphans), are left untouched and
reported.

SAFETY: dry-run by default (prints a full plan, writes nothing). Always dumps a JSON
backup of every affected field's current rows before applying. Requires the Supabase
SERVICE-ROLE key (RLS blocks anon) — pass via env, never on the command line:

  export SUPABASE_URL=https://nutjfdfklbetjzbtulbv.supabase.co
  export SUPABASE_SERVICE_KEY=<service-role key>          # keep out of shell history
  # preview:
  /opt/anaconda3/envs/capers/bin/python scripts/migrate_inspections.py
  # apply:
  /opt/anaconda3/envs/capers/bin/python scripts/migrate_inspections.py --apply
"""
import argparse, gzip, json, os, sys, time, urllib.request, urllib.parse
import numpy as np
from scipy.spatial import cKDTree

AFFECTED = ["GOODS-S", "A2744", "COSMOS", "PRIMER-COSMOS", "PRIMER-UDS"]
PREFIX = {"GOODS-S": "goodss", "A2744": "a2744", "COSMOS": "cosmos",
          "PRIMER-COSMOS": "primercosmos", "PRIMER-UDS": "primeruds"}
VERSION = "0.99"
HERE = os.path.dirname(os.path.abspath(__file__))
INDEXDIR = os.path.join(HERE, "..", "public", "searchindex")

def rest(url, key, method="GET", body=None, prefer=None):
    hdr = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer: hdr["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else None

def load_index(prefix):
    """v0.99 search index: return (ids array, KDTree on tangent-plane coords, ra0/dec0)."""
    p = os.path.join(INDEXDIR, f"{prefix}_search_v{VERSION}.json.gz")
    if not os.path.exists(p):   # cosmos_filters is offloaded, but search index is always here
        raise FileNotFoundError(p)
    idx = json.load(gzip.open(p, "rt"))
    ids = np.asarray(idx["id"]); ra = np.asarray(idx["ra"], float); dec = np.asarray(idx["dec"], float)
    dec0 = float(np.median(dec))
    xy = np.column_stack([(ra * np.cos(np.radians(dec0))), dec])
    return ids, cKDTree(xy), dec0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--tol", type=float, default=0.5, help="match radius arcsec (default 0.5)")
    ap.add_argument("--backup", default=os.path.join(HERE, "inspections_backup.json"))
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL"); key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (service-role key; RLS blocks anon).")

    backup = {}
    plan = []   # (field, old_id, new_id, sep, decision)
    for field in AFFECTED:
        ids, tree, dec0 = load_index(PREFIX[field])
        rows = rest(f"{url}/rest/v1/inspections?field=eq.{urllib.parse.quote(field)}&select=*", key) or []
        backup[field] = rows
        print(f"\n=== {field}: {len(rows)} inspection rows ===")
        for r in rows:
            ra, dec = r.get("ra"), r.get("dec")
            if ra is None or dec is None:
                print(f"  id={r['obj_id']} decision={r['decision']}  NO ra/dec -> SKIP (orphan)"); continue
            q = np.array([ra * np.cos(np.radians(dec0)), dec])
            d, j = tree.query(q)
            sep = d * 3600.0
            new_id = int(ids[j])
            if sep > args.tol:
                print(f"  id={r['obj_id']} ({r['decision']})  no v0.99 obj within {args.tol}\" (nearest {sep:.2f}\") -> SKIP"); continue
            if new_id == int(r["obj_id"]):
                continue  # unchanged
            plan.append((field, int(r["obj_id"]), new_id, sep, r))

    print(f"\n==== {len(plan)} rows to re-key (sep shown) ====")
    for field, old, new, sep, _ in plan[:40]:
        print(f"  {field}: {old} -> {new}  ({sep:.3f}\")")
    if len(plan) > 40: print(f"  ... +{len(plan)-40} more")

    if not args.apply:
        print("\nDRY-RUN — nothing written. Re-run with --apply to migrate.")
        return

    json.dump(backup, open(args.backup, "w"), indent=0)
    print(f"\nbackup written -> {args.backup}")
    done = 0
    for field, old, new, sep, r in plan:
        payload = {"field": field, "obj_id": new, "ra": r["ra"], "dec": r["dec"],
                   "version": VERSION, "z": r.get("z"), "decision": r["decision"],
                   "notes": r.get("notes"), "inspector": r.get("inspector")}
        # delete the stale old-id row, then upsert at the new id
        rest(f"{url}/rest/v1/inspections?field=eq.{urllib.parse.quote(field)}&obj_id=eq.{old}", key, method="DELETE")
        rest(f"{url}/rest/v1/inspections", key, method="POST", body=payload,
             prefer="resolution=merge-duplicates")
        done += 1
        if done % 50 == 0: print(f"  migrated {done}/{len(plan)}"); time.sleep(0.2)
    print(f"\nDONE — migrated {done} rows. Backup at {args.backup} (restore by re-POSTing if needed).")

if __name__ == "__main__":
    main()

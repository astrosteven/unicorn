#!/usr/bin/env python3
"""
pull_inspections.py  --  Pull the Supabase `inspections` table DOWN to the per-field
`<prefix>_inspection_notes_v0.99.json` files that the IDL selection pipeline reads
(the "projector" side of the web inspector; Supabase = source of truth).

The website writes decisions to Supabase (one row per field+obj_id; decision in
keep/remove/not_inspected/undecided; plus notes/inspector/ra/dec). unicorn_doselect
reads a SPARSE notes JSON per field whose records are matched by galaxyObjectID to the
catalog and expanded to full length (see unicorn_parse_json.pro / runall_template.pro):

    inspection = {id: final.id, decision: strarr(N)}     ; default ''
    ...match galaxyObjectID -> set decision = 'Keep'/'Remove'...
    where(decision eq 'Remove') -> inspect=0 (drop from selected)
    where(decision eq 'Keep')   -> inspect=1 (confirmed)

So this script writes, per field, a list of records in the EXACT desktop-inspector shape:

    {"galaxyObjectID": "<v0.99 id>", "decision": "Keep"|"Remove",
     "id": "<UUID>", "notes": "<str>", "lastModified": <mac-epoch secs>}

Only keep/remove rows are emitted (not_inspected/undecided are skipped — they leave the
object at its auto-selection). Each row is DEFENSIVELY re-keyed by ra/dec to the nearest
v0.99 object, so a stale obj_id from an older catalog run is corrected (not silently
applied to the wrong source); rows with no v0.99 match within --tol are dropped (orphans).

Read-only against Supabase. Requires the SERVICE-ROLE key (RLS blocks anon); pass via env:

  export SUPABASE_URL=https://nutjfdfklbetjzbtulbv.supabase.co
  export SUPABASE_SERVICE_KEY=$(cat /tmp/sbkey)     # keep out of shell history
  /opt/anaconda3/envs/capers/bin/python scripts/pull_inspections.py \
      --outdir ~/Research/UNICORN/inspections
"""
import argparse, csv, datetime as dt, glob, gzip, json, os, shutil, sys, urllib.request, uuid
import numpy as np
from scipy.spatial import cKDTree

PREFIX = {"CEERS": "ceers", "GOODS-S": "goodss", "GOODS-N": "goodsn", "A2744": "a2744",
          "NGDEEP": "ngdeep", "EGS": "egs", "PRIMER-COSMOS": "primercosmos",
          "PRIMER-UDS": "primeruds", "COSMOS": "cosmos"}
VERSION = "0.99"
DECISION_OUT = {"keep": "Keep", "remove": "Remove"}   # only these are emitted
MAC_EPOCH = 978307200                                 # unix secs at 2001-01-01 (Cocoa epoch)
HERE = os.path.dirname(os.path.abspath(__file__))
INDEXDIR = os.path.join(HERE, "..", "public", "searchindex")
RESEARCH = os.path.expanduser("~/Research/UNICORN")
# roots searched to locate each field's selection/ dir (incl. the remote mounts where
# GOODS-N/A2744/PRIMER-UDS live on Braize and PRIMER-COSMOS on Threnody).
SELECTION_ROOTS = [RESEARCH, "/Volumes/Braize/UNICORN", "/Volumes/Threnody/UNICORN", "/Volumes/Nalthis/UNICORN"]


def rest(url, key, q):
    req = urllib.request.Request(f"{url}/rest/v1/{q}",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def load_index(prefix):
    d = json.load(gzip.open(os.path.join(INDEXDIR, f"{prefix}_search_v{VERSION}.json.gz"), "rt"))
    ids = np.asarray(d["id"]); ra = np.asarray(d["ra"], float); dec = np.asarray(d["dec"], float)
    dec0 = float(np.median(dec))
    return ids, cKDTree(np.column_stack([ra * np.cos(np.radians(dec0)), dec])), dec0


def mac_epoch(iso):
    """Supabase updated_at (ISO8601) -> Mac/Cocoa epoch seconds (unix - 978307200)."""
    if not iso:
        return 0.0
    try:
        s = iso.replace("Z", "+00:00")
        return dt.datetime.fromisoformat(s).timestamp() - MAC_EPOCH
    except Exception:
        return 0.0


def find_selection_dir(prefix):
    """Locate the field's selection/ dir across all roots (where its notes file lives)."""
    hits = []
    for root in SELECTION_ROOTS:
        if not os.path.isdir(root):
            continue
        hits += glob.glob(os.path.join(root, "**", f"{prefix}_inspection_notes_*.json"), recursive=True)
    hits = [h for h in hits if os.sep + "inspections" + os.sep not in h]  # exclude our staging dir
    return os.path.dirname(sorted(hits)[0]) if hits else None


def load_existing_v099(seldir, prefix):
    """The field's CURRENT v0.99 notes (historical desktop decisions), keyed by galaxyObjectID.
    Only read the v0.99 file — never an older-version file (its ids may be stale)."""
    if not seldir:
        return {}
    p = os.path.join(seldir, f"{prefix}_inspection_notes_v{VERSION}.json")
    if not os.path.exists(p):
        return {}
    try:
        return {str(r["galaxyObjectID"]): r for r in json.load(open(p))}
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(RESEARCH, "inspections"))
    ap.add_argument("--tol", type=float, default=0.5, help="re-key match radius arcsec (default 0.5)")
    ap.add_argument("--apply", action="store_true",
                    help="also copy each merged notes file into its field's selection/ dir "
                         "(backs up the existing one to .bak first). Default: stage in --outdir only.")
    args = ap.parse_args()
    url = os.environ.get("SUPABASE_URL"); key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service-role key; RLS blocks anon).")
    os.makedirs(args.outdir, exist_ok=True)

    rows = rest(url, key, "inspections?select=field,obj_id,ra,dec,version,z,decision,notes,inspector,updated_at")
    byfield = {}
    for r in rows:
        byfield.setdefault(r["field"], []).append(r)

    combined = []
    print(f"{'field':15} {'hist':>5} {'+new':>5} {'chg':>4} {'final':>6}  action")
    for field, prefix in PREFIX.items():
        frows = byfield.get(field, [])
        dest = find_selection_dir(prefix)
        # historical desktop decisions already in the field's v0.99 notes file (keyed by gid)
        merged = dict(load_existing_v099(dest, prefix))   # gid -> record
        nhist = len(merged)
        nnew, nchg, nrekey, norphan, nskip = 0, 0, 0, 0, 0
        conflicts = []
        if frows:
            ids, tree, dec0 = load_index(prefix)
            for r in frows:
                dec_in = (r.get("decision") or "").lower()
                ra, dec = r.get("ra"), r.get("dec")
                new_id, sep, rekeyed, orphan = int(r["obj_id"]), -1.0, 0, 0
                if ra is not None and dec is not None:
                    dist, j = tree.query(np.array([ra * np.cos(np.radians(dec0)), dec]))
                    sep = float(dist * 3600)
                    if sep <= args.tol:
                        cand = int(ids[j])
                        if cand != int(r["obj_id"]):
                            new_id, rekeyed, nrekey = cand, 1, nrekey + 1
                    else:
                        orphan = 1
                combined.append(dict(FIELD=field, OBJ_ID=new_id, OLD_OBJ_ID=int(r["obj_id"]),
                                     DECISION=r.get("decision"), INSPECTOR=r.get("inspector") or "",
                                     NOTES=(r.get("notes") or "").replace("\n", " "),
                                     RA=ra, DEC=dec, SEP_ARCSEC=round(sep, 4),
                                     REKEYED=rekeyed, ORPHAN=orphan, VERSION=r.get("version")))
                if dec_in not in DECISION_OUT:
                    nskip += 1; continue            # not_inspected / undecided -> leave auto-selection
                if orphan:
                    norphan += 1; continue           # no v0.99 counterpart -> drop (would mis-match)
                gid, cap = str(new_id), DECISION_OUT[dec_in]
                prev = merged.get(gid)
                if prev is None:
                    nnew += 1
                elif prev.get("decision") != cap:
                    nchg += 1; conflicts.append((gid, prev.get("decision"), cap))
                else:
                    continue                         # already present, same decision — keep historical record
                # Supabase (web) wins: update decision/notes/lastModified, keep a stable record id
                merged[gid] = {"galaxyObjectID": gid, "decision": cap,
                               "id": (prev or {}).get("id") or str(uuid.uuid4()).upper(),
                               "notes": r.get("notes") or (prev or {}).get("notes", ""),
                               "lastModified": mac_epoch(r.get("updated_at"))}
        notes = sorted(merged.values(), key=lambda x: int(x["galaxyObjectID"]))
        fp = os.path.join(args.outdir, f"{prefix}_inspection_notes_v{VERSION}.json")
        json.dump(notes, open(fp, "w"), indent=1)
        # optionally place into the field's selection/ dir (back up the existing file first)
        act = f"staged ({os.path.basename(fp)})"
        if args.apply and dest:
            tgt = os.path.join(dest, f"{prefix}_inspection_notes_v{VERSION}.json")
            if os.path.exists(tgt):
                shutil.copy2(tgt, tgt + ".bak")
            shutil.copy2(fp, tgt)
            act = f"APPLIED -> {dest}"
        elif args.apply and not dest:
            act = "staged (NO dest dir found — place manually)"
        flag = "  <== conflicts" if conflicts else ""
        print(f"{field:15} {nhist:>5} {nnew:>5} {nchg:>4} {len(notes):>6}  {act}{flag}")
        for gid, old, new in conflicts[:6]:
            print(f"                 conflict id {gid}: historical {old} -> web {new}")

    # combined QA CSV (all rows incl skipped/orphan), worst-sep first
    cp = os.path.join(args.outdir, "inspections_all.csv")
    cols = ["FIELD", "OBJ_ID", "OLD_OBJ_ID", "DECISION", "RA", "DEC", "INSPECTOR", "NOTES",
            "VERSION", "SEP_ARCSEC", "REKEYED", "ORPHAN"]
    with open(cp, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for rec in sorted(combined, key=lambda x: -x["SEP_ARCSEC"]):
            w.writerow(rec)
    print(f"\nQA -> {cp}  ({len(combined)} rows total)")
    print(f"notes JSON in {args.outdir}  — drop each into its field's selection/ dir (see [dest] above)")


if __name__ == "__main__":
    main()

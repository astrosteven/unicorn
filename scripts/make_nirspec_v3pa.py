#!/usr/bin/env python3
"""Generate per-field NIRSpec MSA allowed-position-angle lookups for the UNICORN
NIRSpec MSA planning panel.

WHAT THIS PRODUCES
------------------
For each field (representative target = field CENTER; the V3PA-allowed range varies
only slowly, <~0.1 deg, across a ~arcmin field, so the center is adequate) this
script runs jwst_gtvt over one year starting at a date you PASS IN, and emits a
compact JSON of observable date windows with, per window, the allowed V3PA range
AND the allowed NIRSpec MSA aperture-PA (APA) range.

ANGLE CONVENTIONS (verified against pysiaf SIAF + jwst_gtvt source)
------------------------------------------------------------------
* V3PA (observatory): position angle E of N of the telescope +V3 axis at the
  target. jwst_gtvt computes it as sun_pa + 180 deg ("-V3 pointed toward the sun"),
  i.e. the nominal roll for a given date. (jwst_gtvt/jwst_tvt.py: normal_pa()).
* APA (NRS_FULL_MSA aperture PA): position angle E of N of the aperture's ideal
  +Yidl axis. pysiaf/APT relation:  APA = V3PA + V3IdlYAngle.
  For NRS_FULL_MSA, V3IdlYAngle = +138.5745697 deg (PRDOPSSOC-068), so
  APA = V3PA + 138.5746  <=>  V3PA = APA - 138.5746.
  jwst_gtvt uses THE SAME aperture (NRS_FULL_MSA) and THE SAME relation for its
  'NIRSPEC_nominal_angle' column (jwst_tvt.py: calculate_min_max_pa_angles(),
  nominal_angle = V3PA + get_angle('NIRSPEC','NRS_FULL_MSA','V3IdlYAngle')).
  => gtvt's NIRSPEC_* columns ARE the APA nominal/min/max. We emit them directly
     as the APA range, and also emit the raw V3PA range, to be safe.
* The panel's on-sky frame is north-up, east-left, PA east-of-north; its PA slider
  IS the aperture PA (APA). Handedness verified with pysiaf: at APA=0, +Yidl -> N
  and +Xidl -> W (so the panel's d=-Xidl -> W, s=+Yidl -> N is correct).

ALLOWED RANGE
-------------
On an observable date gtvt reports a nominal V3PA and a max boresight roll
(the JWST roll limit for that Sun pitch). The allowed range is the CENTERED
interval  nominal +/- roll_halfwidth. We store nominal + halfwidth (both for V3PA
and APA) rather than gtvt's already-wrapped min/max columns, because those wrap
mod 360 independently and can read min>max; the centered form is unambiguous.

USAGE
-----
  make_nirspec_v3pa.py --start 2026-09-17 [--fields ceers,goods-s] [--step 1]
                       [--out ../public/nirspec/v3pa]
Requires the 'capers' env python (jwst_gtvt + pysiaf) and live JPL/HORIZONS access
(the bundled ephemeris only covers 2021-12-26..2025-06-12).

NOTE: pysiaf here is PRDOPSSOC-068 while the current online PRD is PRDOPSSOC-073.
The V3IdlYAngle of NRS_FULL_MSA is stable across these; the tiny difference is
irrelevant for V3PA windows. This mismatch is recorded in each JSON ('prd').
"""
import argparse, json, os, sys, warnings
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

# Field centers (RA/Dec deg) — mirror app/data/fields/page.tsx FIELDS[].{ra,dec}.
FIELDS = {
    "ceers":         (214.825, 52.825),
    "egs":           (214.825, 52.825),
    "goods-s":       (53.122, -27.805),
    "goods-n":       (189.228, 62.238),
    "primer-cosmos": (150.119, 2.206),
    "primer-uds":    (34.406, -5.189),
    "ngdeep":        (53.160, -27.784),
    "a2744":         (3.588, -30.400),
    "cosmos":        (150.119, 2.206),
}

OFFSET = None  # filled from pysiaf below (V3IdlYAngle of NRS_FULL_MSA)


def wrap360(x):
    return ((x % 360.0) + 360.0) % 360.0


def build_windows_and_series(mjd, in_for, v3pa_nom, apa_nom, roll_half):
    """Return (windows, samples).

    windows: contiguous observable date spans [{start,end}, ...] — for a plain
      "when is this field visible" readout. (Sun-angle FOR only; per-PA visibility
      is a subset, computed by the site from `samples`.)

    samples: the per-sample achievability series. Each entry is a compact
      [ordinal_day, v3pa_nom_deg, roll_halfwidth_deg] for every OBSERVABLE sample,
      where ordinal_day = MJD - base_mjd (base_mjd stored at top level). On that day
      the achievable V3PA is v3pa_nom +/- roll (=> APA = v3pa_nom + offset +/- roll).
      This lets the panel answer "is APA X achievable and on which dates?" exactly,
      without the nominal-swing ambiguity that merging into wide windows introduces.
    """
    base = None
    windows = []
    samples = []
    cur = None
    for i in range(len(mjd)):
        obs = bool(in_for[i]) and (roll_half[i] is not None) and roll_half[i] > 0
        m = int(round(float(mjd[i])))
        if base is None:
            base = m
        iso = (datetime(1858, 11, 17) + timedelta(days=float(mjd[i]))).strftime("%Y-%m-%d")
        if obs:
            samples.append([m - base, round(float(v3pa_nom[i]), 2), round(float(roll_half[i]), 2)])
            if cur is None:
                cur = {"start": iso, "end": iso}
            else:
                cur["end"] = iso
        else:
            if cur is not None:
                windows.append(cur)
                cur = None
    if cur is not None:
        windows.append(cur)
    return base, windows, samples


def run_field(fid, ra, dec, start, end, step):
    from astropy.time import Time
    from jwst_gtvt.jwst_tvt import Ephemeris
    eph = Ephemeris(Time(start), Time(end))
    df = eph.get_fixed_target_positions(str(ra), str(dec))
    if step > 1:
        df = df.iloc[::step].reset_index(drop=True)
    mjd = df["MJD"].tolist()
    in_for = df["in_FOR"].tolist()
    v3pa = df["V3PA"].tolist()
    apa = df["NIRSPEC_nominal_angle"].tolist()  # == V3PA + V3IdlYAngle for NRS_FULL_MSA
    roll = df["max_boresight"].tolist()          # deg; only meaningful where in_FOR True
    roll_half = [(r if (r is not None and r == r and r > 0) else None) for r in roll]
    return build_windows_and_series(mjd, in_for, v3pa, apa, roll_half)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="ISO start date YYYY-MM-DD (explicit, for reproducibility)")
    ap.add_argument("--end", help="ISO end date; default = start + 366 days")
    ap.add_argument("--fields", default="all", help="comma list of field ids, or 'all'")
    ap.add_argument("--step", type=int, default=1, help="sample every Nth day (coarser = faster)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "nirspec", "v3pa"),
                    help="output directory for <fieldid>.json")
    args = ap.parse_args()

    global OFFSET
    import pysiaf
    from pysiaf import JWST_PRD_VERSION
    OFFSET = float(pysiaf.Siaf("NIRSpec")["NRS_FULL_MSA"].V3IdlYAngle)
    prd = JWST_PRD_VERSION

    start = datetime.strptime(args.start, "%Y-%m-%d")
    end = datetime.strptime(args.end, "%Y-%m-%d") if args.end else start + timedelta(days=366)
    start_s, end_s = start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")

    ids = list(FIELDS.keys()) if args.fields == "all" else [x.strip() for x in args.fields.split(",")]
    os.makedirs(args.out, exist_ok=True)

    for fid in ids:
        if fid not in FIELDS:
            print(f"skip unknown field {fid}", file=sys.stderr)
            continue
        ra, dec = FIELDS[fid]
        print(f"[{fid}] ra={ra} dec={dec} {start_s}..{end_s} step={args.step} ...", flush=True)
        try:
            base, windows, samples = run_field(fid, ra, dec, start_s, end_s, args.step)
        except Exception as e:
            print(f"[{fid}] FAILED: {e}", file=sys.stderr)
            continue
        base_iso = (datetime(1858, 11, 17) + timedelta(days=base)).strftime("%Y-%m-%d") if base is not None else start_s
        obj = {
            "field": fid, "ra": ra, "dec": dec,
            "generated": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "start": start_s, "end": end_s, "step_days": args.step,
            "prd": prd,
            "v3idlyangle": round(OFFSET, 4),      # APA = V3PA + v3idlyangle
            "aperture": "NRS_FULL_MSA",
            "base_date": base_iso,                # samples[i][0] = days after this date
            "note": "APA = V3PA + v3idlyangle (NRS_FULL_MSA). samples=[dayOffset, v3paNom, "
                    "rollHalfwidth] for observable days; achievable V3PA = v3paNom +/- roll "
                    "(APA = that + v3idlyangle). windows=contiguous Sun-angle-visible spans. "
                    "Target = field center.",
            "windows": windows,
            "samples": samples,
        }
        path = os.path.join(args.out, f"{fid}.json")
        with open(path, "w") as f:
            json.dump(obj, f, separators=(",", ":"))
        print(f"[{fid}] wrote {path}: {len(windows)} vis-window(s), {len(samples)} obs-sample(s)", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python
"""Generate JWST instrument footprint polygons for the map's "JWST Footprints" overlay.

Every aperture's SIAF corners are read in the telescope (V2,V3) frame and transformed into the
NRS_FULL_MSA *ideal* frame, then mapped to the map's (d,s) axes via d = -Xidl, s = +Yidl. This
is the EXACT same frame the hand-tuned NIRSpec MSA overlay uses (verified: this pipeline
reproduces MapViewer's hardcoded MSA_QUADS_DS to 0.1"). Because all instruments share that one
frame, the map pins the whole focal plane at a single sky point and rotates it by one aperture
PA (= V3PA + NRS_FULL_MSA V3IdlYAngle) — so every footprint co-registers and rotates correctly.

Each aperture's own V3IdlYAngle/parity is fully baked into its polygon by pysiaf's corners('tel')
+ tel_to_idl, so no per-instrument angle handling is needed on the web side.

Run with the capers env's python (has pysiaf):
    /opt/anaconda3/envs/capers/bin/python scripts/make_siaf_footprints.py
Writes public/nirspec/siaf_footprints.json.
"""
import json
import os
import sys

import pysiaf

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "nirspec", "siaf_footprints.json")

# Curated, recognizable full-field footprints per instrument. NIRCam uses the 8 short-wave
# detectors so the two modules AND the inter-chip gaps show (sources can land in a gap — useful
# for planning). One color per instrument; drawn as outlines.
PLAN = [
    ("NIRCam", "NIRCam", "#4fc3f7", "NIRCam", [
        "NRCA1_FULL", "NRCA2_FULL", "NRCA3_FULL", "NRCA4_FULL",
        "NRCB1_FULL", "NRCB2_FULL", "NRCB3_FULL", "NRCB4_FULL",
    ]),
    ("MIRI", "MIRI", "#ff8a65", "MIRI (imager)", ["MIRIM_FULL"]),
    ("NIRISS", "NIRISS", "#ba68c8", "NIRISS", ["NIS_CEN"]),
    ("FGS", "FGS", "#aed581", "FGS", ["FGS1_FULL", "FGS2_FULL"]),
]

nrs = pysiaf.Siaf("NIRSpec")
msa = nrs["NRS_FULL_MSA"]


def to_ds(ap):
    """SIAF aperture -> list of (d,s) corners in the map's NRS_FULL_MSA ideal frame."""
    v2, v3 = ap.corners("tel")
    xi, yi = msa.tel_to_idl(v2, v3)
    return [[round(float(-x), 3), round(float(y), 3)] for x, y in zip(xi, yi)]


instruments = []
for siaf_name, key, color, label, ap_names in PLAN:
    siaf = pysiaf.Siaf(siaf_name)
    aps = []
    for name in ap_names:
        if name not in siaf.apertures:
            print(f"  WARN {siaf_name}:{name} not in PRD — skipped", file=sys.stderr)
            continue
        aps.append({"name": name, "ds": to_ds(siaf[name])})
    if aps:
        instruments.append({"key": key, "label": label, "color": color, "apertures": aps})
        print(f"{key}: {len(aps)} apertures")

out = {
    "prd": pysiaf.JWST_PRD_VERSION,
    "frame": "NRS_FULL_MSA ideal, d=-Xidl s=+Yidl (arcsec); same frame as the MSA overlay",
    "note": "pin at the NIRSpec MSA reference; rotate all by the aperture PA (APA = V3PA + 138.5746)",
    "instruments": instruments,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print(f"wrote {os.path.relpath(OUT)}  (PRD {out['prd']})")

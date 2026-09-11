"use client";
// LIVE grayscale postage-stamp montage for the inspector. Replaces the pre-baked per-band
// montage PNG: on mount we fetch the RAW SCI cutout pixels from the Worker (fetchStamp) and
// render a labelled grid of <canvas> cells client-side. A single "hardness" slider (k)
// re-stretches every cell INSTANTLY with no refetch — the raw Float32 pixels stay in state,
// so moving the slider just repaints the canvases. On any error (endpoint down / unsupported
// field / not signed in) we fall back to the existing pre-baked <StampMontage> PNG.
import { useEffect, useRef, useState } from "react";
import { fetchStamp, type StampResult } from "@/lib/photometry";
import { StampMontage } from "@/app/data/_card/objectCard";

// Display cell size (px on screen). Cutouts are ~51px @ 30 mas ≈ 1.5″; we upscale them
// nearest-neighbor to this so faint structure reads (matches the old montage's cell scale).
const CELL_PX = 96;

// Stretch "hardness" persisted across objects + sessions. The display range is symmetric
// about 0 (mosaics are sky-subtracted): [-k·noise, +k·noise], inverted so sources are dark.
// Default tuned HARD (unicorn_bioplots look) so faint flux reads dark.
const STRETCH_KEY = "unicorn_stampStretch";
const DEFAULT_K = 2.5;
const K_MIN = 1, K_MAX = 12;

function loadK(): number {
  if (typeof window === "undefined") return DEFAULT_K;
  const raw = window.localStorage.getItem(STRETCH_KEY);
  const v = raw == null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= K_MIN && v <= K_MAX ? v : DEFAULT_K;
}

export function LiveStampMontage({
  field, ra, dec, bands, fallbackUrl,
}: { field: string; ra: number; dec: number; bands?: string[]; fallbackUrl?: string }) {
  const [stamp, setStamp] = useState<StampResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [k, setK] = useState<number>(DEFAULT_K);

  // Read the persisted hardness on mount (client-only; avoids SSR localStorage access).
  useEffect(() => { setK(loadK()); }, []);

  // Fetch raw pixels whenever the object changes. Cached in the fetchStamp module cache, so
  // a precached (or re-opened) object resolves instantly. Errors OR a >20s stall → PNG fallback
  // (the Worker fetches each band over Digest+byte-range; a slow/hung request shouldn't leave
  // the montage stuck on "loading cutouts…" forever).
  useEffect(() => {
    let live = true;
    setStamp(null); setFailed(false);
    const timer = setTimeout(() => { if (live) setFailed(true); }, 20000);
    fetchStamp(field, ra, dec, undefined, bands)
      .then(s => { if (live) { clearTimeout(timer); setStamp(s); } })
      .catch(() => { if (live) { clearTimeout(timer); setFailed(true); } });
    return () => { live = false; clearTimeout(timer); };
    // bandKey in deps so a band-list change refetches; field/ra/dec identify the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, ra, dec, bands ? bands.join(",") : ""]);

  const onK = (v: number) => {
    setK(v);
    try { window.localStorage.setItem(STRETCH_KEY, String(v)); } catch { /* private mode */ }
  };

  // Endpoint down / unsupported field / not signed in → graceful pre-baked PNG fallback.
  if (failed) return fallbackUrl ? <StampMontage url={fallbackUrl} /> : null;

  return (
    <div style={{ width: "100%", marginTop: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "6px" }}>
        <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
          CUTOUTS <span style={{ color: "var(--text-dim)" }}>(SCI · sky-subtracted · dark = flux · each ≈1.5″×1.5″)</span>
        </div>
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "0.68rem", color: "var(--text-muted)", marginLeft: "auto" }}>
          stretch
          <input type="range" min={K_MIN} max={K_MAX} step={0.25} value={k}
            onChange={e => onK(Number(e.target.value))} style={{ width: "120px" }} />
          <span style={{ color: "var(--text-dim)", width: "2.4em", textAlign: "right" }}>{k.toFixed(2)}σ</span>
        </label>
      </div>
      {stamp == null
        ? <div className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)", padding: "1rem 0" }}>loading cutouts…</div>
        : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {stamp.bands.map(b => (
              <StampCell key={b.band} band={b.band} w={b.w} h={b.h} noise={b.noise} pixels={b.pixels} k={k} />
            ))}
          </div>
        )}
    </div>
  );
}

// One band's cell: label above a <canvas> holding the grayscale-stretched cutout. Renders
// the w×h float patch into an ImageData at native resolution, then upscales nearest-neighbor
// (imageSmoothingEnabled=false) to CELL_PX. Re-runs whenever k (the slider) changes.
function StampCell({
  band, w, h, noise, pixels, k,
}: { band: string; w: number; h: number; noise: number; pixels: Float32Array; k: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Symmetric range about 0. A guard for degenerate noise so we never divide by 0.
    const lo = -k * noise;
    const span = 2 * k * noise || 1;

    // Native-resolution grayscale → ImageData. Inverted so bright flux (v large) → dark;
    // NaN (off-image) → white. g = (1 - clamp((v - lo)/span, 0, 1)) * 255.
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i];
      let g: number;
      if (Number.isNaN(v)) {
        g = 255;
      } else {
        let t = (v - lo) / span;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        g = Math.round((1 - t) * 255);
      }
      const o = i * 4;
      d[o] = g; d[o + 1] = g; d[o + 2] = g; d[o + 3] = 255;
    }

    // Blit native px into an offscreen canvas, then draw it upscaled with smoothing off so
    // pixels stay crisp (astro orientation preserved: row-major, no flip).
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    off.getContext("2d")!.putImageData(img, 0, 0);

    canvas.width = CELL_PX; canvas.height = CELL_PX;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, CELL_PX, CELL_PX);
    ctx.drawImage(off, 0, 0, w, h, 0, 0, CELL_PX, CELL_PX);
  }, [w, h, noise, pixels, k]);

  return (
    <div style={{ textAlign: "center" }}>
      <div className="mono" style={{ fontSize: "0.62rem", color: "var(--text-muted)", marginBottom: "2px", whiteSpace: "nowrap" }}>{band}</div>
      <canvas
        ref={canvasRef}
        style={{ width: `${CELL_PX}px`, height: `${CELL_PX}px`, background: "#fff", border: "1px solid var(--border)", borderRadius: "4px", display: "block", imageRendering: "pixelated" }}
      />
    </div>
  );
}

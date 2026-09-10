// Client for the custom-aperture photometry Cloudflare Worker (unicorn-photometry).
// The map's draw tool converts a drawn circle/polygon → sky coords and calls
// measureAperture(); the Worker range-reads the CEERS SCI/ERR mosaics, sums the aperture
// (5×5 subpixel sampling, ERR in quadrature), and returns calibrated flux per band.
//
// Auth: the site already holds an authenticated Supabase session (lib/supabase). We send
// its access_token as a Bearer token — the Worker verifies it against the project's public
// ES256 JWKS. Anonymous users get a thrown "please sign in" (the tool is login-gated).
import { supabase } from "@/lib/supabase";

export const PHOTOMETRY_WORKER_URL =
  "https://unicorn-photometry.unicorn-astro.workers.dev/photometry";

// Aperture shapes accepted by the Worker. Circle center / polygon vertices are sky coords;
// the circle's center rides on the top-level ra/dec of the request.
export type Aperture =
  | { type: "circle"; radius_arcsec: number }
  | { type: "polygon"; vertices: [number, number][] }; // [[ra,dec],…] degrees

export interface BandFlux {
  band: string;
  flux_nJy: number;
  err_nJy: number;
  npix: number;
}

export interface PhotometryResult {
  field: string;
  ra: number;
  dec: number;
  shape: Aperture;
  user: string;
  results: BandFlux[];
  errors?: { band: string; error: string }[];
  meta?: { units: string; calibration: string; note: string };
}

// Measure an aperture at (ra,dec). `bands` optional — omit for the Worker's default set.
// Throws with a readable message on auth failure / Worker error.
export async function measureAperture(
  ra: number,
  dec: number,
  shape: Aperture,
  bands?: string[],
): Promise<PhotometryResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in to measure photometry.");

  const res = await fetch(PHOTOMETRY_WORKER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ field: "CEERS", ra, dec, shape, bands }),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({} as { error?: string }))).error;
    throw new Error(msg ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<PhotometryResult>;
}

// AB magnitude from flux in nJy (nJy zero point = 31.4). Handy for the results panel.
export function abMagFromNJy(flux_nJy: number): number | null {
  return flux_nJy > 0 ? 31.4 - 2.5 * Math.log10(flux_nJy) : null;
}

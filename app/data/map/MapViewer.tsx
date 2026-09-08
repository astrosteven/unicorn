"use client";
// Client-only WebGL viewer wrapper around @fitsgl/core's <FitsExplorer>. Loads the
// producer `fitsgl.json` for the CEERS tile pyramid, renders the interactive color
// map + the source-marker overlay from catalog.csv, and reports marker clicks up to
// the page (by catalog id) so it can open our shared ResultCard.
//
// MUST stay client-only (WebGL2 + window): the route dynamic-imports it with
// { ssr: false }. @fitsgl/core@0.3.2 reads these v0.1.0-built tiles directly
// (manifest v2, catalog v1, config schema v1 — all within this client's supported
// ranges), so no bundled-reference-viewer fallback is needed.
import { useEffect, useRef, useState } from "react";
import { FitsExplorer, type FitsExplorerProps } from "@fitsgl/core/react";
import { loadFitsglConfig, type FitsglConfig } from "@fitsgl/core";

type LoadState = "loading" | "ready" | "error";

// FitsExplorer ships with its "Catalog overlay" defaulting OFF (explorer-state
// `overlay: false`), and there is no prop to seed it on — but this page's whole
// purpose is clicking source markers, so they must be visible + hittable from the
// start. The toggle is a `<button role="switch" aria-label="Catalog overlay">`
// inside the collapsible "View" inspector panel, whose body is unmounted while
// collapsed. So we (1) expand the View panel if needed, then (2) flip the switch
// on. Idempotent — only acts when something is not already in the desired state.
// Returns true once the overlay is on (or was already on).
function autoEnableOverlay(root: HTMLElement | null): boolean {
  if (!root) return false;
  let btn = root.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Catalog overlay"]');
  if (!btn) {
    // The toggle lives in the collapsed "View" panel — expand it, then retry next tick.
    const head = [...root.querySelectorAll<HTMLButtonElement>("button.fgl-panel-head")]
      .find(b => /view/i.test(b.textContent || ""));
    if (head && head.getAttribute("aria-expanded") === "false") head.click();
    btn = root.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Catalog overlay"]');
    if (!btn) return false;                                 // still not mounted; retry later
  }
  if (btn.getAttribute("aria-checked") === "true") return true;  // already on
  if (btn.disabled) return false;                           // markers not loaded yet — retry
  btn.click();
  return true;
}

export default function MapViewer({
  configUrl,
  onSourceClick,
}: {
  /** Absolute URL to the dataset's fitsgl.json (tiles + catalog resolve against it). */
  configUrl: string;
  /** Fired with the clicked marker's catalog id (our card key). */
  onSourceClick: (id: number) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  // Keep the latest click handler in a ref so FitsExplorer's onMarkerClick closure
  // always calls the current one without re-mounting the WebGL viewer. Assigned in an
  // effect (not during render) so it doesn't tear during a concurrent render.
  const clickRef = useRef(onSourceClick);
  useEffect(() => { clickRef.current = onSourceClick; }, [onSourceClick]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Once the viewer is up, turn the catalog overlay on. Markers load asynchronously,
  // so the toggle starts disabled — retry briefly until it takes (or gives up). The
  // setState here happens inside async interval callbacks, not the effect body.
  useEffect(() => {
    if (state !== "ready") return;
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (autoEnableOverlay(rootRef.current) || tries > 40) clearInterval(t);
    }, 150);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    // Reset to the loading state whenever configUrl changes — done asynchronously so
    // it's not a synchronous setState in the effect body (avoids cascading renders).
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setState("loading");
      setConfig(null);
    });
    // loadFitsglConfig fetches + validates + URL-resolves tiles/catalog against configUrl.
    loadFitsglConfig(configUrl)
      .then(cfg => {
        if (cancelled) return;
        setConfig(cfg);
        setState("ready");
      })
      .catch(err => {
        if (cancelled) return;
        console.error("[map] failed to load fitsgl config:", err);
        setErrMsg(err instanceof Error ? err.message : String(err));
        setState("error");
      });
    return () => { cancelled = true; };
  }, [configUrl]);

  if (state === "error") {
    return (
      <MapMessage
        title="Could not load the color map"
        body={
          <>
            The tile dataset (<code style={{ color: "var(--text-muted)" }}>fitsgl.json</code>) failed to
            load from<br />
            <code style={{ color: "var(--text-muted)", wordBreak: "break-all" }}>{configUrl}</code>
            {errMsg && <><br /><span style={{ color: "var(--text-dim)" }}>{errMsg}</span></>}
          </>
        }
      />
    );
  }

  if (state === "loading" || !config) {
    return <MapMessage title="Loading color map…" body="Fetching tile pyramid + source catalog." spin />;
  }

  const explorerProps: FitsExplorerProps = {
    config,
    onMarkerClick: (e) => {
      // The catalog's `id` column becomes marker.id (a string); coerce to our numeric key.
      const raw = e.marker.id;
      const id = Number(raw);
      if (Number.isFinite(id)) clickRef.current(id);
    },
    // A compact hover tooltip so a source's id is visible before clicking.
    markerTooltip: (m) => (m.id != null ? `ID ${m.id}` : null),
    onError: (err) => {
      console.error("[map] FitsExplorer error:", err);
      setErrMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    },
    style: { width: "100%", height: "100%" },
  };

  // rootRef wraps the explorer so the overlay auto-enable effect can find its
  // "Catalog overlay" toggle in the DOM.
  return (
    <div ref={rootRef} style={{ width: "100%", height: "100%" }}>
      <FitsExplorer {...explorerProps} />
    </div>
  );
}

function MapMessage({ title, body, spin }: { title: string; body: React.ReactNode; spin?: boolean }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "12px", textAlign: "center",
      padding: "2rem", background: "#0d0a1a",
    }}>
      {spin && (
        <div style={{
          width: "28px", height: "28px", borderRadius: "50%",
          border: "3px solid rgba(196,144,216,0.25)", borderTopColor: "var(--accent)",
          animation: "unicorn-spin 0.9s linear infinite",
        }} />
      )}
      <div className="mono" style={{ color: "var(--accent)", fontSize: "0.95rem", fontWeight: 700 }}>{title}</div>
      <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.7, maxWidth: "460px" }}>{body}</div>
      <style>{`@keyframes unicorn-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

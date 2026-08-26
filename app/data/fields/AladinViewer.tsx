"use client";
import { useEffect, useRef } from "react";

interface Props {
  ra: number;
  dec: number;
  fov: number;
  name: string;
}

export default function AladinViewer({ ra, dec, fov, name }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<any>(null);

  useEffect(() => {
    // Load Aladin Lite v3 script dynamically
    if (typeof window === "undefined") return;

    const initAladin = () => {
      const A = (window as any).A;
      if (!A || !divRef.current) return;
      // Aladin Lite v3 loads its engine asynchronously — A.aladin() must be called
      // only after the A.init promise resolves, or the viewer renders blank.
      A.init.then(() => {
        if (!divRef.current) return;
        divRef.current.innerHTML = "";
        aladinRef.current = A.aladin(divRef.current, {
          survey: "P/DSS2/color",
          target: `${ra} ${dec}`,
          fov: fov,
          showReticle: true,
          showZoomControl: true,
          showFullscreenControl: true,
          showLayersControl: true,
          showGotoControl: false,
          showShareControl: false,
          showCatalog: false,
          showFrame: false,
          cooFrame: "J2000",
          showProjectionControl: false,
        });
      });
    };

    if ((window as any).A) {
      initAladin();
    } else {
      const existing = document.getElementById("aladin-lite-script");
      if (existing) {
        existing.addEventListener("load", initAladin);
      } else {
        // Load Aladin Lite script (once)
        const script = document.createElement("script");
        script.id = "aladin-lite-script";
        script.src = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
        script.charset = "utf-8";
        script.async = true;
        script.onload = initAladin;
        document.head.appendChild(script);

        // Load Aladin CSS
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";
        document.head.appendChild(link);
      }
    }
  }, []);

  // When field changes, just update position
  useEffect(() => {
    if (aladinRef.current) {
      aladinRef.current.gotoRaDec(ra, dec);
      aladinRef.current.setFov(fov);
    }
  }, [ra, dec, fov]);

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={divRef}
        style={{ width: "100%", height: "420px", background: "#0d0a1a" }}
      />
      <div style={{
        position: "absolute",
        top: "10px",
        left: "10px",
        background: "rgba(13,10,26,0.75)",
        backdropFilter: "blur(6px)",
        borderRadius: "4px",
        padding: "4px 10px",
        fontFamily: "'Space Mono', monospace",
        fontSize: "0.75rem",
        color: "var(--accent)",
        pointerEvents: "none",
        zIndex: 10,
      }}>
        {name}
      </div>
    </div>
  );
}

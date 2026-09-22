"use client";

import { useEffect } from "react";

/**
 * Dev-only loader for the pointr widget.
 * Renders nothing in production and injects no script when not in development,
 * so it never touches your production bundle behaviour.
 *
 * Usage: place <Pointr /> in your root layout.
 */
export function Pointr({ port = 7331 }: { port?: number }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const id = "pointr-script";
    if (document.getElementById(id)) return;

    const script = document.createElement("script");
    script.id = id;
    script.src = `http://localhost:${port}/widget.js`;
    script.async = true;
    document.body.appendChild(script);

    return () => {
      script.remove();
      document.getElementById("pointr-root")?.remove();
    };
  }, [port]);

  return null;
}

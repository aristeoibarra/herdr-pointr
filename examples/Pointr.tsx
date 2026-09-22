"use client";

import { useEffect } from "react";

/**
 * Dev-only loader for the claude-tmux-bridge widget.
 * Renders nothing in production and injects no script when not in development,
 * so it never touches your production bundle behaviour.
 *
 * Usage: place <ClaudeBridge /> in your root layout.
 */
export function ClaudeBridge({ port = 7331 }: { port?: number }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const id = "claude-tmux-bridge-script";
    if (document.getElementById(id)) return;

    const script = document.createElement("script");
    script.id = id;
    script.src = `http://localhost:${port}/widget.js`;
    script.async = true;
    document.body.appendChild(script);

    return () => {
      script.remove();
      document.getElementById("claude-tmux-bridge-root")?.remove();
    };
  }, [port]);

  return null;
}

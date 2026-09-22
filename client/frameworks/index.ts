import type { ComponentInfo, FrameworkAdapter } from "./types.ts";
import { react } from "./react.ts";

/**
 * Tried in order; the first adapter that recognizes the element wins. To add
 * a framework, write `<name>.ts` implementing FrameworkAdapter (react.ts is
 * the example) and add it here.
 */
const adapters: FrameworkAdapter[] = [react];

export function inspectComponent(el: Element): ComponentInfo | null {
  for (const adapter of adapters) {
    try {
      const info = adapter.inspect(el);
      if (info !== null) return info;
    } catch {
      // A framework internal changed shape: fall through, never break a send.
    }
  }
  return null;
}

import type { Prefs } from "./prefs.ts";

/** What every part of the widget shares. */
export interface WidgetContext {
  /** Origin of the bridge that served the script. */
  bridge: string;
  rootId: string;
  host: HTMLElement;
  /** Everything the widget draws lives here, inside the shadow root. */
  layer: HTMLElement;
  /** Aborted on dispose: every document/window listener registers with it. */
  signal: AbortSignal;
  prefs: Prefs;
  savePrefs(): void;
  /**
   * Whether an event target is the widget's own. Events leaving the shadow
   * root are retargeted to the host, so containment in the host is enough.
   */
  isOwn(node: EventTarget | null): boolean;
}

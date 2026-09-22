/** What a framework knows about the component behind a DOM element. */
export interface ComponentInfo {
  /** Lowercase framework id, e.g. "react", "vue". Shown to the agent. */
  framework: string;
  /** Nearest user component, e.g. "ProfileCard". Framework internals skipped. */
  component: string | null;
  /** Ancestry, nearest first, at most three: they name the file to open. */
  componentStack: string[];
  /** The component's props, summarized with `describeProps`. */
  props: Record<string, string> | null;
  /** "src/Card.vue:12", or just the file, when the framework knows it. */
  source: string | null;
}

/**
 * One per framework, in `client/frameworks/<name>.ts`, registered in
 * `index.ts`. Read only what the framework exposes in development builds; an
 * adapter must never throw and must return null for elements it did not render.
 */
export interface FrameworkAdapter {
  name: string;
  inspect(el: Element): ComponentInfo | null;
}

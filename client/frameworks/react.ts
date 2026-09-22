import { describeProps } from "./props.ts";
import type { FrameworkAdapter } from "./types.ts";

/**
 * React adapter. React 19 fiber walking: resolve the owning component name and
 * component stack for a DOM node. React 19 removed `_debugSource`, so source file:line is no
 * longer available from the fiber — but the component identity still is, which
 * is what lets an agent grep straight to the right file.
 *
 * Name-resolution mirrors React DevTools' own logic (memo / forwardRef / lazy).
 */

const Tag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  ForwardRef: 11,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
} as const;

const FORWARD_REF = Symbol.for("react.forward_ref");
const MEMO = Symbol.for("react.memo");
const LAZY = Symbol.for("react.lazy");
const CONTEXT = Symbol.for("react.context");

interface Fiber {
  tag: number;
  type: unknown;
  elementType: unknown;
  memoizedProps: unknown;
  return: Fiber | null;
}

const COMPOSITE_TAGS = new Set<number>([
  Tag.FunctionComponent,
  Tag.ClassComponent,
  Tag.ForwardRef,
  Tag.MemoComponent,
  Tag.SimpleMemoComponent,
]);

function getFiberFromDom(node: Node): Fiber | null {
  for (const key in node) {
    if (key.startsWith("__reactFiber$")) {
      return (node as unknown as Record<string, Fiber>)[key] ?? null;
    }
  }
  return null;
}

function getTypeName(type: unknown): string | null {
  if (type == null) return null;
  if (typeof type === "string") return type;
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  if (typeof type === "object") {
    const t = type as {
      $$typeof?: symbol;
      displayName?: string;
      render?: unknown;
      type?: unknown;
      _payload?: unknown;
      _init?: (payload: unknown) => unknown;
    };
    if (t.displayName) return t.displayName;
    switch (t.$$typeof) {
      case FORWARD_REF: {
        const inner = getTypeName(t.render);
        return inner ? `ForwardRef(${inner})` : "ForwardRef";
      }
      case MEMO: {
        const inner = getTypeName(t.type);
        return inner ? `Memo(${inner})` : "Memo";
      }
      case LAZY: {
        try {
          return getTypeName(t._init?.(t._payload)) ?? "Lazy";
        } catch {
          return "Lazy";
        }
      }
      case CONTEXT:
        return "Context.Consumer";
      default:
        return null;
    }
  }
  return null;
}

function getDisplayNameForFiber(fiber: Fiber): string | null {
  if (!COMPOSITE_TAGS.has(fiber.tag)) return null;
  return getTypeName(fiber.elementType) ?? getTypeName(fiber.type);
}

/**
 * Next.js / React App Router internal wrappers — noise, not user components.
 * Pattern-based (not an exact list) because Next renames these across versions.
 */
const FRAMEWORK_RE = new RegExp(
  [
    // Common framework/HOC suffixes. Next 16 rewrote several of these wrappers
    // and parked the rewrite under a "New" suffix (InnerScrollHandlerNew), so
    // the suffix has to survive one more word.
    "(?:Boundary|Handler|Outlet|Router)(?:New|Old)?$",
    // Context wrappers. They tell you how the app is assembled, never where
    // the element you clicked lives, and an app stacks a lot of them.
    "Provider$",
    "^Providers$",
    "Scroll(?:AndMaybe|And)?Focus", // scroll/focus handlers
    "RenderFromTemplate",
    "HTTPAccessFallback",
    "Fallback",
    "Redirect",
    "NotFound",
    "^__.*__$", // dunder-wrapped internals (__next_root_layout_boundary__)
    // exact internal names without the suffixes above
    "^(?:Suspense|Fragment|ViewTransition|SegmentViewNode|TemplateContext|MetadataOutlet|RouteAnnouncer|ClientPageRoot|ClientSegmentRoot|AppRouter|LayoutRouter|InnerLayoutRouter|OuterLayoutRouter|Root|ServerRoot|AppRoot|DevRoot|HotReload|SegmentStateProvider|ReactDevOverlay|AppDevOverlay|DevOverlay|Postpone)$",
  ].join("|"),
);

function isFramework(name: string): boolean {
  return FRAMEWORK_RE.test(name);
}

/** Nearest user component above a node, skipping framework wrappers. */
function ownerFiber(node: Node): Fiber | null {
  let fiber = getFiberFromDom(node);
  while (fiber) {
    const name = getDisplayNameForFiber(fiber);
    if (name && !isFramework(name)) return fiber;
    fiber = fiber.return;
  }
  return null;
}

/**
 * Ancestry above a node, nearest first. Three is deliberate: the first one or
 * two name the file to open, and everything past that is app structure the
 * agent pays for and does not act on.
 */
function componentStack(node: Node, limit = 3): string[] {
  const stack: string[] = [];
  let fiber = getFiberFromDom(node);
  while (fiber && stack.length < limit) {
    const name = getDisplayNameForFiber(fiber);
    if (name && !isFramework(name) && stack[stack.length - 1] !== name) stack.push(name);
    fiber = fiber.return;
  }
  return stack;
}

export const react: FrameworkAdapter = {
  name: "react",
  inspect(el) {
    if (getFiberFromDom(el) === null) return null;
    const owner = ownerFiber(el);
    return {
      framework: "react",
      component: owner === null ? null : getDisplayNameForFiber(owner),
      componentStack: componentStack(el),
      props: owner === null ? null : describeProps(owner.memoizedProps),
      // React 19 has no source location; the optional data-source Babel plugin
      // (examples/) supplies one, read generically in capture.ts.
      source: null,
    };
  },
};

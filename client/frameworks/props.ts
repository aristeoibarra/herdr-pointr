/**
 * Serializable snapshot of a component's props, so the agent sees the data
 * the component received — not just its rendered output. Values are
 * summarized, never deep-serialized: props can hold huge object graphs.
 * Functions become "ƒ", objects a key list, framework elements a marker.
 * `children` is omitted (the HTML already covers it).
 */
export function describeProps(props: unknown, limit = 15): Record<string, string> | null {
  if (typeof props !== "object" || props === null) return null;
  const out: Record<string, string> = {};
  const keys = Object.keys(props).filter((key) => key !== "children");
  for (const key of keys.slice(0, limit)) out[key] = describeValue(Reflect.get(props, key));
  if (keys.length > limit) out["…"] = `+${keys.length - limit} more`;
  return keys.length > 0 ? out : null;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value);
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "function":
      return "ƒ";
    case "symbol":
      return value.toString();
    case "object": {
      if (Array.isArray(value)) return `Array(${value.length})`;
      const marker: unknown = Reflect.get(value, "$$typeof");
      if (typeof marker === "symbol") return "<ReactElement>";
      const keys = Object.keys(value);
      return `{${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}}`;
    }
    default:
      return String(value);
  }
}

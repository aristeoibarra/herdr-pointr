import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrAgent } from "./herdr.ts";
import { cwdsForPort } from "./ports.ts";

/** A pinned destination. The session is what tells "same pane, new agent" apart. */
export interface AgentPin {
  paneId: string;
  /** Null for a pin stored before sessions were tracked; adopted on first use. */
  session: string | null;
}

export interface StaleTarget {
  paneId: string;
  reason: "pane_closed" | "session_replaced";
}

export type ResolvedVia = "override" | "pin" | "port" | "config" | "only";

export type Resolution =
  | { kind: "resolved"; agent: HerdrAgent; via: ResolvedVia; stale: StaleTarget | null; trace: string[] }
  | { kind: "ambiguous"; candidates: HerdrAgent[]; trace: string[] }
  | { kind: "none"; candidates: HerdrAgent[]; trace: string[] };

export interface RoutingInput {
  agents: HerdrAgent[];
  /** Page URL from the widget; the dev-server port is read off it. */
  url: string;
  /** Per-tab choice from the widget, beats the persisted pin. */
  override: AgentPin | null;
  /** Persisted pin from config. */
  pin: AgentPin | null;
  projectPath: string | null;
}

/** Files that make a directory look like a project someone works in. */
const PROJECT_MARKERS = [".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "deno.json"];

function normalize(dir: string): string {
  if (dir === "/") return "/";
  return dir.replace(/\/+$/, "");
}

function isAncestor(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function depth(dir: string): number {
  return normalize(dir).split("/").filter((segment) => segment.length > 0).length;
}

/** Where an agent is working. `cwd` is the pane's own directory. */
function agentDir(agent: HerdrAgent): string | null {
  return agent.cwd.length > 0 ? normalize(agent.cwd) : null;
}

/**
 * Whether a dev server's working directory is evidence of *which project* it
 * serves.
 *
 * This is the actual fix for the mis-routing bug, and it is worth being precise
 * about why. A dev server started from `$HOME` has every agent below it as a
 * descendant, so any containment rule matches all of them and something has to
 * break the tie. There is no correct tie to break: `$HOME` simply says nothing
 * about which project is being served. So it is rejected as evidence, the port
 * step yields nothing, and the caller ends up asking the user instead of
 * quietly picking whichever path sorted first.
 *
 * Applies only to the dev server's directory, never to an agent's — an agent
 * legitimately sits anywhere.
 */
export function isInformativeProjectDir(dir: string): boolean {
  const normalized = normalize(dir);
  const home = normalize(homedir());

  // Reject the universal ancestors outright, before looking at markers: a
  // dotfiles $HOME is a git repo and would otherwise pass.
  if (normalized === "/" || normalized === home || normalized === normalize(tmpdir())) return false;
  if (isAncestor(normalized, home)) return false;

  try {
    if (!statSync(normalized).isDirectory()) return false;
  } catch {
    return false;
  }
  return PROJECT_MARKERS.some((marker) => existsSync(join(normalized, marker)));
}

/**
 * Agents plausibly working on `dir`, in tiers. The tiers are ordered and
 * exclusive: once one produces candidates, the rest are never consulted.
 *
 * Replaces a rule that matched whenever either path was a prefix of the other
 * and then took the longest path. That compared *characters*, in one direction,
 * across unrelated relationships — so `/a/bbbbbbbbbb` outranked `/a/b/c`.
 *
 * Returning more than one agent means genuinely ambiguous. The caller asks;
 * it does not guess.
 */
export function matchAgents(dir: string, agents: HerdrAgent[]): HerdrAgent[] {
  const target = normalize(dir);
  const located = agents.filter((agent) => agentDir(agent) !== null);

  const exact = located.filter((agent) => agentDir(agent) === target);
  if (exact.length > 0) return exact;

  // The agent sits above the dev server: a monorepo agent at /repo with the
  // server in /repo/apps/web. The *deepest* ancestor is the nearest one, which
  // is what keeps an agent in $HOME from shadowing one in the project dir.
  const ancestors = located.filter((agent) => {
    const dirOf = agentDir(agent);
    return dirOf !== null && dirOf !== target && isAncestor(dirOf, target);
  });
  if (ancestors.length > 0) {
    const deepest = Math.max(...ancestors.map((agent) => depth(agentDir(agent) ?? "")));
    return ancestors.filter((agent) => depth(agentDir(agent) ?? "") === deepest);
  }

  // The agent sits below: server at the repo root, agent in a subpackage.
  // Shallowest is nearest here.
  const descendants = located.filter((agent) => {
    const dirOf = agentDir(agent);
    return dirOf !== null && dirOf !== target && isAncestor(target, dirOf);
  });
  if (descendants.length > 0) {
    const shallowest = Math.min(...descendants.map((agent) => depth(agentDir(agent) ?? "")));
    return descendants.filter((agent) => depth(agentDir(agent) ?? "") === shallowest);
  }

  return [];
}

function portOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).port || null;
  } catch {
    return null;
  }
}

/** Check a pin against live agents, reporting how it has gone stale. */
function usePin(
  pin: AgentPin,
  agents: HerdrAgent[],
  via: ResolvedVia,
  trace: string[],
): Resolution | null {
  const agent = agents.find((candidate) => candidate.paneId === pin.paneId);
  if (agent === undefined) {
    trace.push(`${via}: pane ${pin.paneId} is gone`);
    return null;
  }
  if (pin.session !== null && agent.sessionId !== null && agent.sessionId !== pin.session) {
    // The agent was restarted in the same terminal. The pin names a terminal,
    // not a conversation, so it still points at the right place — but the
    // caller should say so rather than pretend nothing changed.
    trace.push(`${via}: pane ${pin.paneId} kept, session replaced`);
    return {
      kind: "resolved",
      agent,
      via,
      stale: { paneId: pin.paneId, reason: "session_replaced" },
      trace,
    };
  }
  trace.push(`${via}: pane ${pin.paneId}`);
  return { kind: "resolved", agent, via, stale: null, trace };
}

/**
 * Pick the destination agent.
 *
 * Order: per-tab override, persisted pin, dev-server port, configured project,
 * sole agent. Every step appends to `trace`, which `/debug` and `/resolve`
 * return — given the class of bug this replaces, being able to see *why* a
 * route was chosen is worth more than the route itself.
 */
export async function resolveTarget(input: RoutingInput): Promise<Resolution> {
  const trace: string[] = [];
  const { agents } = input;

  if (agents.length === 0) {
    trace.push("no agents running");
    return { kind: "none", candidates: [], trace };
  }

  if (input.override !== null) {
    const resolved = usePin(input.override, agents, "override", trace);
    if (resolved !== null) return resolved;
  }

  if (input.pin !== null) {
    const resolved = usePin(input.pin, agents, "pin", trace);
    if (resolved !== null) return resolved;
  }

  const port = portOf(input.url);
  if (port === null) {
    trace.push("url carries no port");
  } else {
    const dirs = await cwdsForPort(port);
    if (dirs.length === 0) {
      trace.push(`port ${port}: nothing listening, or its cwd is unreadable`);
    } else {
      const informative = dirs.filter(isInformativeProjectDir);
      if (informative.length === 0) {
        trace.push(`port ${port}: ${dirs.join(", ")} says nothing about which project this is`);
      } else {
        const matched = new Map<string, HerdrAgent>();
        for (const dir of informative) {
          for (const agent of matchAgents(dir, agents)) matched.set(agent.paneId, agent);
        }
        const winners = [...matched.values()];
        const first = winners[0];
        if (winners.length === 1 && first !== undefined) {
          trace.push(`port ${port} -> ${informative.join(", ")} -> ${first.paneId}`);
          return { kind: "resolved", agent: first, via: "port", stale: null, trace };
        }
        if (winners.length > 1) {
          trace.push(`port ${port} -> ${informative.join(", ")} -> ${winners.length} agents match equally`);
          return { kind: "ambiguous", candidates: winners, trace };
        }
        trace.push(`port ${port} -> ${informative.join(", ")} -> no agent there`);
      }
    }
  }

  if (input.projectPath !== null) {
    const matched = matchAgents(input.projectPath, agents);
    const first = matched[0];
    if (matched.length === 1 && first !== undefined) {
      trace.push(`configured project ${input.projectPath} -> ${first.paneId}`);
      return { kind: "resolved", agent: first, via: "config", stale: null, trace };
    }
    if (matched.length > 1) {
      trace.push(`configured project ${input.projectPath} -> ${matched.length} agents match equally`);
      return { kind: "ambiguous", candidates: matched, trace };
    }
    trace.push(`configured project ${input.projectPath} -> no agent there`);
  }

  const only = agents[0];
  if (agents.length === 1 && only !== undefined) {
    trace.push(`only one agent running -> ${only.paneId}`);
    return { kind: "resolved", agent: only, via: "only", stale: null, trace };
  }

  trace.push(`${agents.length} agents running, none identifiable for this page`);
  return { kind: "none", candidates: agents, trace };
}

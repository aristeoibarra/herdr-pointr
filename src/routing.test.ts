import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { HerdrAgent } from "./herdr.ts";
import { isInformativeProjectDir, matchAgents, upstreamUrl } from "./routing.ts";

/**
 * These cover the one place in the bridge where being wrong is invisible:
 * routing does not fail, it delivers somewhere else. Every case here is a
 * shape that actually misrouted, or the rule that stops it from happening
 * again.
 */

function agent(paneId: string, cwd: string): HerdrAgent {
  return {
    paneId,
    workspaceId: paneId.split(":")[0] ?? "",
    tabId: "",
    kind: "claude",
    status: "idle",
    cwd,
    title: "",
    sessionId: null,
    focused: false,
  };
}

/** Every directory is a project, so tier rules can be tested on their own. */
const anyDir = (): boolean => true;
const ids = (agents: HerdrAgent[]): string[] => agents.map((a) => a.paneId);

describe("matchAgents", () => {
  it("prefers an exact directory over anything else", () => {
    const agents = [agent("w1:p1", "/repo"), agent("w2:p1", "/repo/apps/web")];
    expect(ids(matchAgents("/repo/apps/web", agents, anyDir))).toEqual(["w2:p1"]);
  });

  it("takes the deepest ancestor", () => {
    const agents = [agent("w1:p1", "/a"), agent("w2:p1", "/a/b")];
    expect(ids(matchAgents("/a/b/c", agents, anyDir))).toEqual(["w2:p1"]);
  });

  it("takes the shallowest descendant", () => {
    const agents = [agent("w1:p1", "/repo/apps/web/src"), agent("w2:p1", "/repo/apps")];
    expect(ids(matchAgents("/repo", agents, anyDir))).toEqual(["w2:p1"]);
  });

  it("prefers an ancestor over a longer-named descendant", () => {
    // This is the regression, and it only shows up across tiers: within one
    // tier every candidate is a prefix of the next, so "deepest" and "longest
    // string" agree and a length sort looks correct. They part company here.
    // The old rule sorted every match by character length, so the descendant
    // won and a project's feedback went to an unrelated session.
    const agents = [agent("w1:p1", "/repo"), agent("w2:p1", "/repo/apps/web/src/components")];
    expect(ids(matchAgents("/repo/apps/web", agents, anyDir))).toEqual(["w1:p1"]);
  });

  it("reports every tie rather than breaking it", () => {
    const agents = [agent("w1:p1", "/repo/a"), agent("w2:p1", "/repo/b")];
    expect(ids(matchAgents("/repo", agents, anyDir)).sort()).toEqual(["w1:p1", "w2:p1"]);
  });

  it("refuses an ancestor whose own directory is not a project", () => {
    // $HOME contains every project on the machine, so containment alone would
    // make it win this tier for all of them.
    const home = agent("w1:p1", "/home/someone");
    const isProject = (dir: string): boolean => dir !== "/home/someone";
    expect(ids(matchAgents("/home/someone/percep", [home], anyDir))).toEqual(["w1:p1"]);
    expect(matchAgents("/home/someone/percep", [home], isProject)).toEqual([]);
  });

  it("still lets a real project ancestor win", () => {
    const agents = [agent("w1:p1", "/home/someone"), agent("w2:p1", "/home/someone/repo")];
    const isProject = (dir: string): boolean => dir !== "/home/someone";
    expect(ids(matchAgents("/home/someone/repo/apps/web", agents, isProject))).toEqual(["w2:p1"]);
  });

  it("ignores trailing slashes on both sides", () => {
    const agents = [agent("w1:p1", "/repo/")];
    expect(ids(matchAgents("/repo", agents, anyDir))).toEqual(["w1:p1"]);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    // "/repo-old" starts with "/repo" as a string but is not inside it.
    const agents = [agent("w1:p1", "/repo-old")];
    expect(matchAgents("/repo/apps", agents, anyDir)).toEqual([]);
  });

  it("skips agents with no directory at all", () => {
    expect(matchAgents("/repo", [agent("w1:p1", "")], anyDir)).toEqual([]);
  });
});

describe("isInformativeProjectDir", () => {
  const root = mkdtempSync(join(tmpdir(), "pointr-routing-"));

  it("accepts a directory carrying a project marker", () => {
    const project = join(root, "acme");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), "{}");
    expect(isInformativeProjectDir(project)).toBe(true);
  });

  it("rejects a directory with no marker", () => {
    const plain = join(root, "notes");
    mkdirSync(plain);
    expect(isInformativeProjectDir(plain)).toBe(false);
  });

  it("rejects the universal ancestors outright", () => {
    // Checked before markers on purpose: a dotfiles $HOME is a git repo and
    // would otherwise pass.
    expect(isInformativeProjectDir("/")).toBe(false);
    expect(isInformativeProjectDir(process.env["HOME"] ?? "/root")).toBe(false);
  });

  it("rejects a path that does not exist", () => {
    expect(isInformativeProjectDir(join(root, "gone"))).toBe(false);
  });
});

describe("upstreamUrl", () => {
  const aliases = new Map([["13000", "3000"]]);

  // Untranslated, the proxy port leads to the bridge's own process, whose cwd
  // is pointr's checkout: every proxied page would route to pointr's agent.
  it("rewrites a proxy port to the dev-server port it fronts", () => {
    expect(upstreamUrl("http://localhost:13000/settings?tab=2#x", aliases)).toBe(
      "http://localhost:3000/settings?tab=2#x",
    );
  });

  it("leaves a page opened directly untouched", () => {
    expect(upstreamUrl("http://localhost:3000/", aliases)).toBe("http://localhost:3000/");
  });

  it("leaves a URL with no port or no URL at all untouched", () => {
    expect(upstreamUrl("http://localhost/", aliases)).toBe("http://localhost/");
    expect(upstreamUrl("not a url", aliases)).toBe("not a url");
  });
});

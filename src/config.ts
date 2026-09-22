import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { AgentPin } from "./routing.ts";

export interface BridgeConfig {
  /**
   * Pinned destination, or null to resolve at send time. Carries the agent's
   * session id as well as the pane id: a pane id alone cannot tell "the agent
   * restarted in this terminal" from "nothing changed".
   */
  targetAgent: AgentPin | null;
  /** Project path used to match an agent when nothing else resolves. */
  projectPath: string | null;
  /** HTTP port the bridge listens on. */
  port: number;
  /**
   * herdr socket to talk to. Null = HERDR_SOCKET_PATH, then the default
   * session. Set it explicitly when the bridge runs as a detached daemon: a
   * service manager starts with a fresh environment, so a named session's
   * socket path has to be configured rather than inherited.
   */
  herdrSocketPath: string | null;
  /** Path to whisper.cpp's CLI. Null = look it up in PATH / the usual prefixes. */
  whisperBin: string | null;
  /** Path to a ggml model. Null = pick the best one found on disk. */
  whisperModel: string | null;
}

export const DEFAULT_PORT = 7331;

/**
 * When herdr runs us as a plugin it hands us a config directory of its own,
 * which survives reinstalling the plugin. Outside herdr we fall back to the
 * usual XDG-ish location so the bridge still works standalone.
 */
function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config", "claude-tmux-bridge");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

const DEFAULT_CONFIG: BridgeConfig = {
  targetAgent: null,
  projectPath: null,
  port: DEFAULT_PORT,
  herdrSocketPath: null,
  whisperBin: null,
  whisperModel: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPin(value: unknown): AgentPin | null {
  // A pin saved before sessions were tracked is a bare pane-id string. Lift it
  // and let the session be adopted the first time it resolves.
  if (typeof value === "string") return value.length > 0 ? { paneId: value, session: null } : null;
  if (!isRecord(value)) return null;
  const paneId = value["paneId"];
  if (typeof paneId !== "string" || paneId.length === 0) return null;
  const session = value["session"];
  return { paneId, session: typeof session === "string" ? session : null };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function loadConfig(): Promise<BridgeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configFile(), "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!isRecord(parsed)) return { ...DEFAULT_CONFIG };

  const port = parsed["port"];
  return {
    targetAgent: readPin(parsed["targetAgent"] ?? parsed["targetPane"]),
    projectPath: readString(parsed["projectPath"]),
    port: typeof port === "number" && Number.isInteger(port) ? port : DEFAULT_PORT,
    herdrSocketPath: readString(parsed["herdrSocketPath"]),
    whisperBin: readString(parsed["whisperBin"]),
    whisperModel: readString(parsed["whisperModel"]),
  } satisfies BridgeConfig;
}

export async function saveConfig(config: BridgeConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

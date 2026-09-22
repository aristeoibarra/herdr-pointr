/**
 * Local speech-to-text for the widget's dictation button, via whisper.cpp.
 *
 * The browser's Web Speech API is not an option: Chromium only ships Google's
 * hosted recognizer, and Brave disables it outright (it fails with
 * "not-allowed" and no prompt). So the widget records the audio and this
 * transcribes it on the machine — no cloud, works in any browser.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeConfig } from "./config.ts";

const run = promisify(execFile);

/** `whisper-cli` is the current name; `whisper-cpp`/`main` are older builds. */
const BIN_NAMES = ["whisper-cli", "whisper-cpp"];
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")];

const MODEL_DIRS = [
  join(homedir(), ".local", "share", "whisper-cpp"),
  join(homedir(), ".cache", "whisper-cpp"),
  join(homedir(), "Library", "Application Support", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp",
  "/usr/local/share/whisper-cpp",
  "/usr/share/whisper-cpp",
];

/**
 * Auto-pick order. `small` first on purpose: on Apple Silicon it transcribes a
 * dictation-length clip in a couple of seconds, and the accuracy gap to
 * `medium` doesn't pay for the wait when you're standing there watching.
 */
const MODEL_PREFERENCE = ["small", "medium", "large", "base", "tiny"];

const TIMEOUT_MS = 120_000;

export interface WhisperSetup {
  bin: string;
  model: string;
}

export interface DictationStatus {
  available: boolean;
  /** Basename of the model in use, for the Settings hint. */
  model?: string;
  error?: string;
}

let cached: WhisperSetup | null = null;

async function which(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/which", [name]);
    const path = stdout.trim();
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

async function findBin(config: BridgeConfig): Promise<string | null> {
  if (config.whisperBin) return existsSync(config.whisperBin) ? config.whisperBin : null;
  for (const name of BIN_NAMES) {
    const found = await which(name);
    if (found) return found;
    // launchd's PATH is minimal even with the plist override on older installs.
    const direct = BIN_DIRS.map((dir) => join(dir, name)).find((p) => existsSync(p));
    if (direct) return direct;
  }
  return null;
}

/** Score a `ggml-*.bin` filename by MODEL_PREFERENCE; -1 means "not a model". */
function modelRank(file: string): number {
  if (!file.startsWith("ggml-") || !file.endsWith(".bin")) return -1;
  if (file.startsWith("for-tests-")) return -1;
  // English-only models would mistranscribe every other language.
  if (file.includes(".en.")) return -1;
  const index = MODEL_PREFERENCE.findIndex((size) => file.includes(size));
  return index === -1 ? -1 : MODEL_PREFERENCE.length - index;
}

async function findModel(config: BridgeConfig): Promise<string | null> {
  if (config.whisperModel) return existsSync(config.whisperModel) ? config.whisperModel : null;
  let best: { path: string; rank: number } | null = null;
  for (const dir of MODEL_DIRS) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const rank = modelRank(file);
      if (rank < 0) continue;
      if (!best || rank > best.rank) best = { path: join(dir, file), rank };
    }
  }
  return best?.path ?? null;
}

async function resolveSetup(config: BridgeConfig): Promise<WhisperSetup> {
  if (cached) return cached;
  const bin = await findBin(config);
  if (!bin) {
    throw new Error(
      "whisper.cpp not found — install it with `brew install whisper-cpp`, or set whisperBin in the bridge config.",
    );
  }
  const model = await findModel(config);
  if (!model) {
    throw new Error(
      `No whisper model found. Download one (e.g. ggml-small.bin) into ~/.local/share/whisper-cpp, or set whisperModel in the bridge config.`,
    );
  }
  cached = { bin, model };
  return cached;
}

export async function dictationStatus(config: BridgeConfig): Promise<DictationStatus> {
  try {
    const setup = await resolveSetup(config);
    return { available: true, model: setup.model.split("/").pop() ?? setup.model };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** BCP-47 from the browser → whisper's ISO-639-1 ("es-MX" → "es", "auto" stays). */
function whisperLang(tag: string): string {
  if (tag === "" || tag === "auto") return "auto";
  const base = tag.split("-")[0]?.toLowerCase() ?? "auto";
  return /^[a-z]{2}$/.test(base) ? base : "auto";
}

/** whisper emits bracketed markers for non-speech; they're noise in a prompt. */
function cleanTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^[[(][^\])]*[\])]$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribeWav(wav: Buffer, language: string, config: BridgeConfig): Promise<string> {
  const setup = await resolveSetup(config);
  const dir = join(tmpdir(), "herdr-pointr");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `dictation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await writeFile(file, wav);
  const threads = Math.max(2, Math.min(8, cpus().length - 2));
  try {
    const { stdout } = await run(
      setup.bin,
      ["-m", setup.model, "-f", file, "-nt", "-np", "-l", whisperLang(language), "-t", String(threads)],
      { timeout: TIMEOUT_MS, maxBuffer: 4_000_000 },
    );
    return cleanTranscript(stdout);
  } finally {
    await rm(file, { force: true });
  }
}

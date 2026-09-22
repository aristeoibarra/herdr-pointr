/**
 * Dictation for the composer: record here, transcribe on the bridge.
 *
 * Not the Web Speech API — Chromium only ships Google's hosted recognizer and
 * Brave disables it outright (it fails "not-allowed" with no prompt). Instead we
 * capture raw PCM, encode a 16 kHz mono WAV (what whisper.cpp wants) and POST it
 * to the bridge, which runs whisper locally. Nothing leaves the machine.
 *
 * The tradeoff vs. the browser API: no live partial text — you get the whole
 * phrase when you stop talking.
 */

interface PagePolicy {
  allowsFeature(feature: string): boolean;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
  /** Not in lib.dom: `permissionsPolicy` is the current name, `featurePolicy` the Chromium one. */
  interface Document {
    permissionsPolicy?: PagePolicy;
    featurePolicy?: PagePolicy;
  }
}

export type DictationState = "idle" | "recording" | "transcribing";

export interface DictationHandlers {
  onState(state: DictationState): void;
  /** 0..1 loudness while recording, so the mic can show it's hearing something. */
  onLevel(level: number): void;
  onText(text: string): void;
  onError(message: string): void;
}

export interface Dictation {
  readonly supported: boolean;
  state(): DictationState;
  /** Open the mic. `language` is a BCP-47 tag or "auto". */
  start(language: string): void;
  /** Stop and transcribe what was captured. */
  stop(): void;
  /** Stop and throw the audio away. */
  cancel(): void;
}

export const POLICY_MESSAGE =
  "This page's Permissions-Policy header disables the microphone (microphone=()). Use microphone=(self) in dev — the padlock cannot override it.";

/** whisper.cpp only accepts 16 kHz; asking the AudioContext for it avoids resampling. */
const TARGET_RATE = 16_000;
const MAX_SECONDS = 120;
const MIN_SECONDS = 0.2;
const LEVEL_INTERVAL_MS = 100;

export function createDictation(bridgeOrigin: string, handlers: DictationHandlers): Dictation {
  const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
  const canCapture =
    typeof navigator.mediaDevices?.getUserMedia === "function" && AudioCtor !== undefined;
  if (!AudioCtor || !canCapture) {
    return {
      supported: false,
      state: () => "idle",
      start: () => undefined,
      stop: () => undefined,
      cancel: () => undefined,
    };
  }

  let state: DictationState = "idle";
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let chunks: Float32Array[] = [];
  let frames = 0;
  let language = "auto";
  let levelAt = 0;
  /** Bumped on cancel so a late transcription can't land in the composer. */
  let generation = 0;

  function setState(next: DictationState): void {
    if (state === next) return;
    state = next;
    handlers.onState(next);
  }

  function teardown(): void {
    processor?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    if (processor) processor.onaudioprocess = null;
    stream?.getTracks().forEach((track) => track.stop()); // drops the browser's mic indicator
    void ctx?.close().catch(() => undefined);
    processor = null;
    source = null;
    sink = null;
    stream = null;
    ctx = null;
  }

  function collected(): { samples: Float32Array; rate: number } {
    const rate = ctx?.sampleRate ?? TARGET_RATE;
    const merged = new Float32Array(frames);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return { samples: merged, rate };
  }

  async function open(): Promise<boolean> {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      // Keep the raw DOMException reachable: "NotAllowedError" covers four very
      // different fixes and the message is what tells them apart.
      console.warn("[pointr] microphone request failed:", error);
      handlers.onError(await micError(error));
      return false;
    }
    if (state !== "recording") {
      // Stopped or cancelled while the permission prompt was up — don't leave the
      // mic open behind an idle UI.
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return false;
    }
    ctx = new AudioCtor({ sampleRate: TARGET_RATE });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      frames += input.length;
      reportLevel(input);
      if (frames / (ctx?.sampleRate ?? TARGET_RATE) >= MAX_SECONDS) {
        handlers.onError(`Stopped at ${MAX_SECONDS}s — transcribing what was captured.`);
        stop();
      }
    };
    // A ScriptProcessor only runs while it's connected to the graph; a muted gain
    // node keeps it alive without playing the mic back through the speakers.
    sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    return true;
  }

  function reportLevel(input: Float32Array): void {
    const now = Date.now();
    if (now - levelAt < LEVEL_INTERVAL_MS) return;
    levelAt = now;
    let sum = 0;
    for (const sample of input) sum += sample * sample;
    const rms = Math.sqrt(sum / input.length);
    handlers.onLevel(Math.min(1, rms * 8));
  }

  async function transcribe(wav: ArrayBuffer, mine: number): Promise<void> {
    try {
      const res = await fetch(`${bridgeOrigin}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: toBase64(new Uint8Array(wav)), language }),
      });
      const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
      if (generation !== mine) return; // cancelled while whisper was running
      if (!data.ok) handlers.onError(data.error ?? "Transcription failed.");
      else if (data.text) handlers.onText(data.text);
      else handlers.onError("Nothing recognized — try again closer to the mic.");
    } catch {
      if (generation === mine) handlers.onError("Bridge unreachable — could not transcribe.");
    } finally {
      if (generation === mine) setState("idle");
    }
  }

  function stop(): void {
    if (state !== "recording") return;
    const { samples, rate } = collected();
    teardown();
    chunks = [];
    frames = 0;
    if (samples.length < rate * MIN_SECONDS) {
      setState("idle");
      return;
    }
    setState("transcribing");
    const pcm = rate === TARGET_RATE ? samples : resample(samples, rate, TARGET_RATE);
    void transcribe(encodeWav(pcm, TARGET_RATE), generation);
  }

  return {
    supported: true,
    state: () => state,
    start(lang) {
      if (state !== "idle") return;
      language = lang;
      chunks = [];
      frames = 0;
      levelAt = 0;
      setState("recording");
      void open().then((ok) => {
        if (!ok) {
          teardown();
          setState("idle");
        }
      });
    },
    stop,
    cancel() {
      generation += 1;
      teardown();
      chunks = [];
      frames = 0;
      setState("idle");
    },
  };
}

/**
 * A page can switch the mic off for every origin — itself included — with a
 * `Permissions-Policy: microphone=()` header (a common security-headers preset).
 * The site permission in the padlock cannot override it, so detect it and say so
 * instead of sending people to a toggle that does nothing.
 */
export function micBlockedByPagePolicy(): boolean {
  const policy = document.permissionsPolicy ?? document.featurePolicy;
  if (!policy) return false;
  try {
    return !policy.allowsFeature("microphone");
  } catch {
    return false;
  }
}

/** Permissions API — typed loosely because lib.dom's PermissionName omits "microphone". */
async function micPermission(): Promise<string | null> {
  const api: { query(descriptor: { name: string }): Promise<{ state: string }> } | undefined =
    navigator.permissions;
  if (!api) return null;
  try {
    return (await api.query({ name: "microphone" })).state;
  } catch {
    return null;
  }
}

/**
 * "NotAllowedError" is four different problems wearing one name: the site is
 * blocked, the prompt was dismissed, macOS is blocking the browser itself, or
 * the page can't ask at all. Each needs a different fix, so name the right one.
 */
async function micError(error: unknown): Promise<string> {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "Microphone is busy in another app.";
  if (name !== "NotAllowedError" && name !== "SecurityError") {
    return `Could not open the microphone (${name || "unknown"}: ${detail}).`;
  }
  if (micBlockedByPagePolicy()) return POLICY_MESSAGE;
  if (!window.isSecureContext) {
    return `Dictation needs a secure context — use http://localhost or https, not ${location.origin}.`;
  }
  if (window.self !== window.top) {
    return "This page is in an iframe without microphone permission — load the widget in the top frame.";
  }
  // Chromium says "system" when it's the OS, not the site, doing the blocking.
  if (/system/i.test(detail)) {
    return "macOS is blocking the browser's microphone — System Settings › Privacy & Security › Microphone.";
  }
  const permission = await micPermission();
  if (permission === "denied") {
    return `Microphone blocked for ${location.host} — padlock in the address bar › Site settings › Microphone › Allow, then reload.`;
  }
  if (/dismiss/i.test(detail)) return "Permission dismissed — click the mic again and choose Allow.";
  return `Microphone request denied (${detail || name}) — allow it for ${location.host} and retry.`;
}

/** Linear resample — only a fallback; AudioContext normally captures at 16 kHz already. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = (input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac;
  }
  return out;
}

/** Exported for the WAV round-trip check in scripts; the widget uses it via createDictation. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** btoa in slices — spreading a megabyte-sized array blows the call stack. */
function toBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

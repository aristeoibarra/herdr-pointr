import { createServer } from "./server.ts";
import { loadConfig, saveConfig, configFile, DEFAULT_PORT } from "./config.ts";
import { listAgents, isAvailable, setSocketPath, socketPath } from "./herdr.ts";
import { portStrategy } from "./ports.ts";
import { shutdownWatchers } from "./watch.ts";
import { dictationStatus } from "./transcribe.ts";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = await loadConfig();
  setSocketPath(config.herdrSocketPath);

  switch (command) {
    case "serve":
    case "start":
      await serve(config, rest);
      return;
    case "agents":
      await printAgents();
      return;
    case "pin":
      await pin(rest);
      return;
    case "doctor":
      await doctor();
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      fail(`Unknown command: ${command}\n`);
  }
}

async function serve(config: Awaited<ReturnType<typeof loadConfig>>, args: string[]): Promise<void> {
  const portArg = readFlag(args, "--port");
  if (portArg) config.port = Number.parseInt(portArg, 10);
  const projectArg = readFlag(args, "--project");
  if (projectArg) config.projectPath = projectArg;

  const server = createServer(config);
  server.listen(config.port, () => {
    log(`bridge listening on http://localhost:${config.port}`);
    log(`widget:  http://localhost:${config.port}/widget.js`);
    log(`herdr:   ${socketPath()}`);
    if (config.targetAgent) log(`target:  ${config.targetAgent.paneId} (pinned)`);
    else log("target:  resolved per page (dev-server port -> project dir -> agent)");
  });

  // An open event stream keeps the server from closing, so SIGINT would hang
  // forever without ending them first.
  const shutdown = (): void => {
    shutdownWatchers();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function printAgents(): Promise<void> {
  if (!(await isAvailable())) fail(`No herdr server answering at ${socketPath()}.`);
  const agents = await listAgents();
  if (agents.length === 0) {
    log("herdr is running, but no agents are open.");
    return;
  }
  log("agents:");
  for (const agent of agents) {
    log(`  ${agent.paneId.padEnd(10)} ${agent.kind.padEnd(10)} ${agent.status.padEnd(8)} ${agent.cwd}`);
  }
}

/**
 * Pinning is rarely needed — routing is automatic — but it settles the case
 * where several agents legitimately match one project.
 */
async function pin(args: string[]): Promise<void> {
  const config = await loadConfig();

  if (args.includes("--clear")) {
    config.targetAgent = null;
    await saveConfig(config);
    log("pin cleared — the bridge resolves the agent per page again.");
    return;
  }

  // Default to the pane this ran in, which is what herdr exports to an agent.
  const paneId = args.find((arg) => /^w\d+:p\d+$/.test(arg)) ?? process.env.HERDR_PANE_ID ?? null;
  if (paneId === null) {
    fail("No pane to pin. Run this inside a herdr pane, or pass one: `pin w1:p1`.");
  }

  const agent = (await listAgents()).find((candidate) => candidate.paneId === paneId);
  if (agent === undefined) fail(`herdr reports no agent in pane ${paneId}.`);

  config.targetAgent = { paneId: agent.paneId, session: agent.sessionId };
  await saveConfig(config);
  log(`pinned ${agent.paneId} (${agent.kind}) in ${agent.cwd}`);
  log(`saved to ${configFile()}`);
}

/** Everything the bridge needs, and whether it is actually there. */
async function doctor(): Promise<void> {
  const herdr = await isAvailable();
  log(`herdr socket   ${herdr ? "ok" : "MISSING"}  ${socketPath()}`);
  if (herdr) {
    const agents = await listAgents();
    log(`agents         ${agents.length} open`);
  }

  const strategy = portStrategy();
  log(`port lookup    ${strategy === "none" ? `UNSUPPORTED on ${process.platform}` : `ok (${strategy})`}`);

  const config = await loadConfig();
  const dictation = await dictationStatus(config);
  log(`dictation      ${dictation.available ? `ok (${dictation.model ?? "model"})` : `off — ${dictation.error ?? "unavailable"}`}`);
  log(`config         ${configFile()}`);
}

function printHelp(): void {
  log(
    [
      "Send selected browser elements into the coding agent that owns the project.",
      "",
      "Usage:",
      "  serve [--port N] [--project PATH]  Run the bridge in the foreground (default :" + DEFAULT_PORT + ")",
      "  agents                             List the agents herdr can see",
      "  pin [w1:p1|--clear]                Pin/clear a destination agent (rarely needed)",
      "  doctor                             Check herdr, port lookup and dictation",
      "",
      "Routing is automatic: the page's dev-server port maps to the directory it",
      "was launched from, which maps to the agent working there. Pin only when",
      "several agents legitimately match one project.",
    ].join("\n"),
  );
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index !== -1 && index + 1 < args.length) return args[index + 1] ?? null;
  return null;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

void main();

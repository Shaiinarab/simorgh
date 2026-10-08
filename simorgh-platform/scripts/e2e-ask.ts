#!/usr/bin/env node
// ── e2e-ask — the platform reaching a core it did not deploy ───────────────────
//
// The unit suites each prove a piece. This proves the *claim the modularization was
// for*: `simorgh-platform` is a control plane that can connect a phoenix-core it did
// not deploy, over either connector, and get an answer back.
//
// Nothing on the platform's side is mocked. The CLI runs as its own process, reads a
// real fleet file, dials real HTTP, and the core it reaches is a real phoenix-core on a
// real port with real SQLite underneath it.
//
// The one stand-in is the *provider* — a stub that returns a canned answer — so the run
// needs no vendor key and never touches the network. What is under test is the boundary,
// not Groq.
//
// The assertion that matters most is the last one: the **same question asked through the
// REST connector and through the MCP connector returns the same answer**. That is the
// platform's central promise ("a caller cannot tell which connector answered"), and until
// now it was only ever asserted against stubs. Here it is asserted against one live core
// reached two genuinely different ways.
//
// Run: npm run e2e:ask     (exits 0 only when the whole path works)

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Provider } from "@simorgh/phoenix-core";

import { startNodeRuntime } from "../src/runtimes/node.ts";

const API_KEY = "e2e-ask-token";
const ANSWER = "Simorgh is the thirty birds who became one.";
const QUESTION = "who is simorgh";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

const execFileAsync = promisify(execFile);

/** A provider that answers instantly, so this run needs no key and no network. */
const stub: Provider = {
  id: "e2e-stub",
  name: "E2E stub",
  provider: "in-process",
  model: "stub-1",
  priority: 1,
  async call() {
    return { ok: true, answer: ANSWER };
  },
};

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name} — ${detail}\n`);
}

/**
 * Run the CLI as a real subprocess and return its stdout.
 *
 * **Asynchronous on purpose, and this is the bug the first version had.** The core runs
 * in *this* process, so `execFileSync` deadlocks the demo: it blocks this event loop
 * while waiting for a CLI that is waiting for an HTTP response from the server that this
 * event loop would have to serve. The observed symptom was a 75-second timeout after the
 * first check, with the core happily listening and never answering.
 *
 * Awaiting the subprocess yields the event loop, so the core serves the request. Any
 * harness that drives an in-process server from a subprocess has to be async for exactly
 * this reason.
 *
 * A non-zero exit rejects, which is right: the CLI's exit codes are part of its contract
 * (`0` healthy, `1` unhealthy, `2` refused), so a command that exits non-zero when it
 * should have succeeded fails the run instead of being quietly tolerated.
 */
async function cli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    // A global proxy env var intercepts 127.0.0.1 on this box; the CLI must not be
    // proxied away from the core it is talking to.
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
  });
  return stdout;
}

/** The first line of `ask` output that is the answer, not the provenance footer. */
function answerOf(output: string): string {
  return output.split("\n").find((line) => line.trim() === ANSWER)?.trim() ?? "";
}

/**
 * The recorded instances, read from the fleet file the CLI actually wrote.
 *
 * The file is a versioned object (`{ version: 1, instances: [...] }`), not a bare array —
 * so reading `.length` off the parse result yields `undefined`. That is what the first run
 * of this script reported, and it is the kind of thing only a real read of the real file
 * catches.
 */
function fleetInstances(path: string): unknown[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { instances?: unknown[] };
  return Array.isArray(parsed.instances) ? parsed.instances : [];
}

async function main(): Promise<number> {
  const workdir = mkdtempSync(join(tmpdir(), "simorgh-e2e-"));
  const fleet = join(workdir, "fleet.json");

  const runtime = await startNodeRuntime({
    port: 0, // ephemeral: never collides with a core already running on this box
    apiKey: API_KEY,
    providers: [stub],
    sqlPath: ":memory:",
  });

  process.stdout.write(`phoenix-core (self-hosted) at ${runtime.url}\n\n`);
  process.stdout.write("Platform CLI → real core, over real HTTP\n\n");

  try {
    // 1. The core is up and says so.
    const health = await fetch(`${runtime.url}/health`);
    record("core-is-up", health.ok, `GET /health → http_${health.status}`);

    // 2. The platform records it — over REST.
    await cli([
      "connect", "node", runtime.url, "--id", "rest", "--connector", "rest",
      "--api-key", API_KEY, "--fleet", fleet,
    ]);
    const afterRest = fleetInstances(fleet);
    record("connect-over-rest", afterRest.length === 1, `fleet file holds ${afterRest.length} instance(s)`);

    // 3. The platform records the *same core* again — over MCP.
    //    A separate id because the two connectors are two different ways in, and the
    //    fleet should be able to hold both views of one core.
    await cli([
      "connect", "node", `${runtime.url}/mcp`, "--id", "mcp", "--connector", "mcp",
      "--api-key", API_KEY, "--fleet", fleet,
    ]);
    const afterMcp = fleetInstances(fleet);
    record("connect-over-mcp", afterMcp.length === 2, `fleet file holds ${afterMcp.length} instance(s)`);

    // 4. Ask, forcing the REST connector.
    const restOut = await cli(["ask", QUESTION, "--prefer", "rest", "--fleet", fleet]);
    record("ask-via-rest", answerOf(restOut) === ANSWER, `answer matched, ${restOut.split("\n").length} lines of output`);

    // 5. Ask the same question, forcing MCP.
    const mcpOut = await cli(["ask", QUESTION, "--prefer", "mcp", "--fleet", fleet]);
    record("ask-via-mcp", answerOf(mcpOut) === ANSWER, "answer matched");

    // 6. The promise: the two connectors are indistinguishable to the caller.
    const restAnswer = answerOf(restOut);
    const mcpAnswer = answerOf(mcpOut);
    record(
      "connectors-agree",
      restAnswer !== "" && restAnswer === mcpAnswer,
      `rest === mcp (${JSON.stringify(restAnswer.slice(0, 40))}…)`
    );

    // 7. Provenance is reported, and names the provider that actually answered — which
    //    the caller could not otherwise tell, since both connectors produced one answer.
    //    The footer is `answered by <instance> → <provider name> · <provider id>✓`.
    record(
      "provenance-reported",
      /answered by rest →/.test(restOut) &&
        /answered by mcp →/.test(mcpOut) &&
        /e2e-stub✓/.test(restOut) &&
        /e2e-stub✓/.test(mcpOut),
      "both answers name the answering instance and the provider that answered"
    );

    // 8. `status` and `doctor` agree the fleet is healthy — exit 0 is the assertion.
    const statusOut = await cli(["status", "--fleet", fleet]);
    const doctorOut = await cli(["doctor", "--fleet", fleet]);
    record("status-healthy", statusOut.includes("e2e-stub"), "status lists the live provider");
    record("doctor-healthy", /no errors|0 problem/.test(doctorOut), "doctor found no problems");

    // 9. Disconnect is real state change, not a print.
    await cli(["disconnect", "mcp", "--fleet", fleet]);
    const afterDisconnect = fleetInstances(fleet);
    record("disconnect-removes", afterDisconnect.length === 1, `${afterDisconnect.length} instance(s) remain`);

    process.stdout.write("\n── ask via REST ──\n");
    process.stdout.write(restOut);
    process.stdout.write("── ask via MCP ──\n");
    process.stdout.write(mcpOut);
  } finally {
    await runtime.close();
    rmSync(workdir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(
    `\n${checks.length - failed.length}/${checks.length} checks passed\n`
  );
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // A demo that prints a stack trace teaches nothing about what broke. Report the
  // message, keep the exit code non-zero, and let the checks already printed stand.
  process.stderr.write(
    `e2e-ask: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

#!/usr/bin/env node
// ── simorgh — the platform CLI ────────────────────────────────────────────────
//
// Run it unbuilt: `node simorgh-platform/src/cli.ts <command>` (or `npm run simorgh`).
//
// Commands are grouped by the three questions the platform exists to answer:
//
//   where can a core live?    targets, plan, deploy
//   which cores are mine?     connect, instances, disconnect
//   what are they doing?      status, ask
//
// Plus `serve` and `smoke` for the self-hosted runtime.
//
// ── The consent gate ──
//
// `deploy --mode cli` runs real commands, so it requires `--yes`. Without it the
// command prints exactly what it would have run and exits 2. There is no ambient
// approval: no env var, no config file, no "we're in CI so obviously yes".

import { parseArgs } from "node:util";

import { applyDeployPlan, renderReport } from "./deploy/apply.ts";
import { buildDeployPlan, renderPlan } from "./deploy/plan.ts";
import { renderPreflight, runPreflight } from "./deploy/preflight.ts";
import { childProcessRunner, recordingRunner } from "./deploy/runner.ts";
import {
  addInstance,
  createFleet,
  instanceIdFor,
  removeInstance,
  type CoreInstance,
} from "./fleet.ts";
import { defaultFleetPath, loadFleet, saveFleet } from "./fleet-store.ts";
import { diagnoseInstances, renderDoctor } from "./doctor.ts";
import { getTarget, listTargets, type DeploymentMode } from "./targets.ts";
import type { ConnectorKind } from "./connectors/types.ts";
import { startNodeRuntime } from "./runtimes/node.ts";
import { runSmoke } from "./runtimes/smoke.ts";

const USAGE = `simorgh — connect and deploy phoenix-core instances

Where a core can live
  simorgh targets                             list deployment targets
  simorgh plan <target> [options]             show what deploying there involves
  simorgh deploy <target> [options]           deploy (--mode manual | cli)

Options for plan/deploy
  --mode manual|cli        manual renders steps for you; cli runs the runnable ones
  --service <name>         instance name, substituted into the endpoint
  --origin <host:port>     address the core will be reachable at
  --yes                    required to actually execute a cli-mode deploy
  --dry-run                execute through a recording runner: prints, runs nothing
  --skip-preflight         deploy even when preflight finds blockers
  --json                   machine-readable output

Which cores are mine
  simorgh connect <target> <endpoint> [--connector rest|mcp] [--api-key <token>]
  simorgh instances                           list recorded instances
  simorgh disconnect <id>                     forget an instance
  --fleet <path>           fleet file (default ${defaultFleetPath()})

What are they doing
  simorgh status                              health + flock of every instance
  simorgh doctor                              why an instance is not answering
  simorgh ask "<prompt>" [--tools a,b] [--prefer <id>]

This box
  simorgh serve [--port <n>]                  run a self-hosted phoenix-core
  simorgh smoke                               boot a core, probe it, exit 0/1
`;

interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

function parse(argv: readonly string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      mode: { type: "string" },
      service: { type: "string" },
      origin: { type: "string" },
      connector: { type: "string" },
      "api-key": { type: "string" },
      id: { type: "string" },
      tools: { type: "string" },
      prefer: { type: "string" },
      port: { type: "string" },
      fleet: { type: "string" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "skip-preflight": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  return { values, positionals };
}

const out = (line = "") => process.stdout.write(line + "\n");

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  const [command, ...rest] = positionals;

  if (!command || command === "help" || values.help) {
    out(USAGE);
    return 0;
  }

  switch (command) {
    case "targets":
      return cmdTargets(values);
    case "plan":
      return cmdPlan(rest[0], values);
    case "deploy":
      return cmdDeploy(rest[0], values);
    case "connect":
      return cmdConnect(rest[0], rest[1], values);
    case "instances":
      return cmdInstances(values);
    case "disconnect":
      return cmdDisconnect(rest[0], values);
    case "status":
      return cmdStatus(values);
    case "doctor":
      return cmdDoctor(values);
    case "ask":
      return cmdAsk(rest.join(" "), values);
    case "serve":
      return cmdServe(values);
    case "smoke":
      return cmdSmoke(values);
    default:
      out(`Unknown command '${command}'.`);
      out();
      out(USAGE);
      return 2;
  }
}

// ── deployment ──

function cmdTargets(values: Parsed["values"]): number {
  const targets = listTargets();
  if (values.json) {
    out(JSON.stringify(targets, null, 2));
    return 0;
  }
  out("Deployment targets");
  out();
  for (const target of targets) {
    out(`  ${target.id}`);
    out(`    ${target.label}`);
    out(`    runtime ${target.runtime} · speaks ${target.connectors.join(", ")} · modes ${target.modes.join(", ")}`);
    out(`    endpoint ${target.endpoint}`);
    const required = target.secrets.filter((s) => s.required).map((s) => s.name);
    out(`    required secrets: ${required.length > 0 ? required.join(", ") : "none"}`);
    out();
  }
  return 0;
}

function buildPlanFrom(targetId: string | undefined, values: Parsed["values"]) {
  if (!targetId) throw new Error("A target id is required. Run `simorgh targets`.");
  const mode = (values.mode as DeploymentMode | undefined) ?? "manual";
  if (mode !== "manual" && mode !== "cli") {
    throw new Error(`--mode must be 'manual' or 'cli', not '${mode}'.`);
  }
  return buildDeployPlan({
    targetId,
    mode,
    env: process.env,
    ...(typeof values.service === "string" ? { service: values.service } : {}),
    ...(typeof values.origin === "string" ? { origin: values.origin } : {}),
  });
}

function cmdPlan(targetId: string | undefined, values: Parsed["values"]): number {
  const plan = buildPlanFrom(targetId, values);
  if (values.json) {
    out(JSON.stringify(plan, null, 2));
    return 0;
  }
  out(renderPlan(plan));
  return 0;
}

async function cmdDeploy(targetId: string | undefined, values: Parsed["values"]): Promise<number> {
  const plan = buildPlanFrom(targetId, values);
  if (values.json) out(JSON.stringify(plan, null, 2));
  else out(renderPlan(plan));

  if (plan.mode === "manual") {
    out();
    out("Nothing was executed: manual mode. Re-run with --mode cli to run the [run] steps.");
    return 0;
  }

  // ── Preflight, before the consent gate ──
  //
  // Ordering is the whole point. A missing token or a missing tool used to be discovered
  // *during* the run — after `npm ci` had taken two minutes and before step 4 died — which
  // leaves the deploy half-applied, the most expensive state a deployer can produce. So the
  // blockers are printed before the operator is asked to type `--yes`, and a blocked plan
  // does not start at all.
  //
  // `--skip-preflight` exists because a gate with no override gets worked around, not
  // respected. It is explicit, it is printed, and it is not a config file or an env var.
  const skipPreflight = values["skip-preflight"] === true;
  if (!skipPreflight) {
    const preflight = await runPreflight({ plan, env: process.env });
    out();
    out(renderPreflight(preflight));
    if (!preflight.ok) {
      out();
      out("Refusing to deploy: preflight found blockers, and nothing was executed.");
      out("Fix them, or re-run with --skip-preflight to override.");
      return 2;
    }
  } else {
    out();
    out("Preflight skipped at your request (--skip-preflight).");
  }

  const dryRun = values["dry-run"] === true;
  if (!dryRun && values.yes !== true) {
    const executable = plan.steps.filter((step) => step.executable).length;
    out();
    out(
      `Refusing to execute. ${executable} step(s) would run real commands on this machine.`
    );
    out("Re-run with --yes to proceed, or --dry-run to see the calls without running them.");
    return 2;
  }

  const report = await applyDeployPlan(plan, {
    runner: dryRun ? recordingRunner() : childProcessRunner(),
    env: process.env,
    confirmed: true,
    onStep: (outcome) => {
      if (outcome.status === "ok") out(`  ok      ${outcome.step.id}`);
      else if (outcome.status === "manual") out(`  manual  ${outcome.step.id}`);
      else out(`  FAILED  ${outcome.step.id} (${outcome.reason})`);
    },
  });
  out();
  out(renderReport(report));
  return report.ok ? 0 : 1;
}

// ── the fleet ──

function fleetPath(values: Parsed["values"]): string {
  return typeof values.fleet === "string" ? values.fleet : defaultFleetPath();
}

async function loadInstances(path: string): Promise<CoreInstance[]> {
  return loadFleet(path, (message) => out(`warning: ${message}`));
}

async function cmdConnect(
  targetId: string | undefined,
  endpoint: string | undefined,
  values: Parsed["values"]
): Promise<number> {
  if (!targetId || !endpoint) {
    throw new Error("Usage: simorgh connect <target> <endpoint>");
  }
  // Validate the target id here so a typo fails before anything is written.
  getTarget(targetId);

  const connector = (values.connector as ConnectorKind | undefined) ?? "rest";
  if (connector !== "rest" && connector !== "mcp") {
    throw new Error(`--connector must be 'rest' or 'mcp', not '${connector}'.`);
  }

  const instance: CoreInstance = {
    id: typeof values.id === "string" ? values.id : instanceIdFor(targetId, endpoint),
    targetId,
    endpoint,
    connector,
    ...(typeof values["api-key"] === "string" ? { apiKey: values["api-key"] } : {}),
  };

  // Probe before recording. An instance saved without a reachable core is a landmine
  // for the next `simorgh ask`, which would then blame the fleet for a typo.
  const fleet = createFleet([instance]);
  const [report] = await fleet.status();
  if (!report?.health.reachable) {
    out(`Cannot reach ${endpoint} over ${connector}: ${report?.health.detail ?? "unknown error"}`);
    out("Nothing was recorded.");
    return 1;
  }

  const path = fleetPath(values);
  const instances = addInstance(await loadInstances(path), instance);
  await saveFleet(instances, path);

  out(`Connected ${instance.id}`);
  out(`  ${report.health.detail}${report.health.latencyMs !== undefined ? ` · ${report.health.latencyMs}ms` : ""}`);
  if (report.flock) {
    for (const bird of report.flock.birds) {
      out(`  ${bird.id.padEnd(10)} ${bird.status.padEnd(8)} ${bird.provider}`);
    }
  }
  out(`Fleet file: ${path} (${instances.length} instance(s))`);
  return 0;
}

async function cmdInstances(values: Parsed["values"]): Promise<number> {
  const path = fleetPath(values);
  const instances = await loadInstances(path);
  if (values.json) {
    out(JSON.stringify(instances, null, 2));
    return 0;
  }
  if (instances.length === 0) {
    out(`No instances recorded in ${path}.`);
    out("Add one with: simorgh connect <target> <endpoint>");
    return 0;
  }
  for (const instance of instances) {
    out(`  ${instance.id}`);
    out(`    ${instance.endpoint} via ${instance.connector} (target ${instance.targetId})`);
  }
  return 0;
}

async function cmdDisconnect(id: string | undefined, values: Parsed["values"]): Promise<number> {
  if (!id) throw new Error("Usage: simorgh disconnect <id>");
  const path = fleetPath(values);
  const instances = await loadInstances(path);
  if (!instances.some((i) => i.id === id)) {
    out(`No instance '${id}' in ${path}.`);
    return 1;
  }
  await saveFleet(removeInstance(instances, id), path);
  out(`Disconnected ${id}.`);
  return 0;
}

// ── talking to the fleet ──

async function cmdStatus(values: Parsed["values"]): Promise<number> {
  const instances = await loadInstances(fleetPath(values));
  if (instances.length === 0) {
    out("No instances. Connect one first: simorgh connect <target> <endpoint>");
    return 1;
  }
  const reports = await createFleet(instances).status();
  if (values.json) {
    out(JSON.stringify(reports, null, 2));
    return 0;
  }
  let unreachable = 0;
  for (const report of reports) {
    const latency = report.health.latencyMs !== undefined ? ` ${report.health.latencyMs}ms` : "";
    out(`${report.instance.id}  [${report.instance.connector}]${latency}`);
    if (!report.health.reachable) {
      unreachable += 1;
      out(`  UNREACHABLE — ${report.health.detail}`);
      continue;
    }
    if (report.error) out(`  reachable, but status failed: ${report.error}`);
    for (const bird of report.flock?.birds ?? []) {
      out(`  ${bird.id.padEnd(10)} ${bird.status.padEnd(8)} ${bird.model}`);
    }
  }
  return unreachable === reports.length ? 1 : 0;
}

async function cmdDoctor(values: Parsed["values"]): Promise<number> {
  const instances = await loadInstances(fleetPath(values));
  const report = await diagnoseInstances(instances);
  if (values.json) {
    out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  out(renderDoctor(report));
  out();
  out(
    report.ok
      ? `${report.diagnoses.length} check(s), no errors.`
      : `${report.diagnoses.filter((d) => d.severity === "error").length} problem(s) found.`
  );
  return report.ok ? 0 : 1;
}

async function cmdAsk(prompt: string, values: Parsed["values"]): Promise<number> {
  if (!prompt.trim()) throw new Error('Usage: simorgh ask "<prompt>"');
  const instances = await loadInstances(fleetPath(values));
  if (instances.length === 0) {
    out("No instances. Connect one first: simorgh connect <target> <endpoint>");
    return 1;
  }
  const tools =
    typeof values.tools === "string"
      ? (values.tools.split(",").map((t) => t.trim()).filter(Boolean) as never)
      : undefined;
  const prefer = typeof values.prefer === "string" ? values.prefer.split(",") : undefined;

  const outcome = await createFleet(instances).ask(
    { prompt, ...(tools ? { tools } : {}) },
    { ...(prefer ? { prefer } : {}) }
  );
  for (const skip of outcome.skipped) out(`skipped ${skip.id}: ${skip.error}`);
  out(outcome.result.answer || "(no answer)");
  out();
  out(
    `answered by ${outcome.instance.id} → ${outcome.result.answeredBy} · ${outcome.result.attempts
      .map((a) => `${a.providerId}${a.ok ? "✓" : "✗"}`)
      .join(" → ")}`
  );
  return outcome.result.success ? 0 : 1;
}

// ── this box ──

async function cmdServe(values: Parsed["values"]): Promise<number> {
  const port = typeof values.port === "string" ? Number(values.port) : undefined;
  const runtime = await startNodeRuntime({
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    apiKey: process.env.SIMORGH_API_KEY,
    secrets: process.env,
    corsOrigins: process.env.CORS_ORIGINS,
  });
  out(`phoenix-core listening on ${runtime.url}`);
  if (!process.env.SIMORGH_API_KEY) {
    out("warning: SIMORGH_API_KEY is unset — authenticated routes fail closed with 503.");
  }
  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Park until a signal arrives; `serve` is the only command that does not return.
  return new Promise<number>(() => {});
}

async function cmdSmoke(values: Parsed["values"]): Promise<number> {
  const outcome = await runSmoke({ env: process.env });
  if (values.json) {
    out(JSON.stringify(outcome, null, 2));
    return outcome.ok ? 0 : 1;
  }
  out(`phoenix-core smoke run (${outcome.url})`);
  for (const check of outcome.checks) {
    out(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  return outcome.ok ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // A CLI that prints a stack trace for "you forgot an argument" is a CLI people
  // stop using. Known failures get the message; the exit code stays non-zero.
  process.stderr.write(`simorgh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

#!/usr/bin/env bun
// ── e2e-bun — drive the Bun runtime over real HTTP ──
//
// Boots the Bun runtime as a subprocess and drives it over HTTP,
// proving the same core contract the Node runtime serves:
// health, flock status, auth fail-closed, MCP handshake, and the
// exact tool list.
//
// Run: bun simorgh-platform/scripts/e2e-bun.ts

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const BUN = "/home/shai/.bun/bin/bun";
const PORT = 8897;
const API_KEY = "e2e-bun-token";
const ROOT = import.meta.dirname + "/..";

interface CheckResult {
  ok: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function record(ok: boolean, detail: string): void {
  checks.push({ ok, detail });
  process.stdout.write(`${ok ? "[ok]" : "[FAIL]"} ${detail}\n`);
}

function startChild(env: NodeJS.ProcessEnv): {
  child: ReturnType<typeof spawn>;
  started: Promise<boolean>;
} {
  const child = spawn(BUN, [
    "run",
    ROOT + "/src/runtimes/bun.ts",
    "--port", String(PORT),
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { process.stderr.write(d); });

  const started = new Promise<boolean>((resolve) => {
    const timer = setInterval(() => {
      if (/listening/.test(stdout)) { clearInterval(timer); resolve(true); }
    }, 100);
    child.on("exit", () => { clearInterval(timer); resolve(false); });
    setTimeout(() => { clearInterval(timer); resolve(/listening/.test(stdout)); }, 10_000);
  });

  return { child, started };
}

async function main(): Promise<number> {
  const workdir = mkdtempSync(tmpdir() + "/simorgh-e2e-bun-");

  const baseEnv = { ...process.env, NO_PROXY: "127.0.0.1,localhost" };

  // ── Phase 1: without API key — prove fail-closed 503 ──
  const { child: child1, started: started1 } = startChild(baseEnv);
  if (!await started1) {
    record(false, "bun runtime started without API key");
    child1.kill("SIGTERM");
    return 1;
  }
  record(true, "bun runtime started without API key");

  const baseUrl = "http://127.0.0.1:" + PORT;

  try {
    // 1. GET /health → 200, status: "ok"
    {
      const res = await fetch(baseUrl + "/health");
      const body = await res.json() as { status: string };
      record(res.status === 200 && body.status === "ok",
        "GET /health → " + res.status + ", status: \"" + body.status + "\"");
    }

    // 2. GET /api/v1/flock/status → 200, parses, reports provider state
    // The response field is `birds` — the flock keeps its bird names on the wire
    // (see phoenix-core/src/flock.ts: `return { birds, timestamp }`).
    {
      const res = await fetch(baseUrl + "/api/v1/flock/status");
      const body = await res.json() as { birds?: { status?: string }[] };
      const states = (body.birds ?? []).map((b) => b.status ?? "?").join(",");
      record(res.status === 200 && Array.isArray(body.birds),
        "GET /api/v1/flock/status → " + res.status + ", birds: " + (body.birds?.length ?? "?") + (states ? " [" + states + "]" : ""));
    }

    // 3. POST /api/v1/agent/execute without token → 503 (fail-closed)
    {
      const res = await fetch(baseUrl + "/api/v1/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      record(res.status === 503,
        "POST /api/v1/agent/execute no token → " + res.status + " (fail-closed)");
    }
  } finally {
    child1.kill("SIGTERM");
    const exitCode = await new Promise<number>((resolve) => {
      child1.on("exit", (code) => resolve(code ?? 0));
      setTimeout(() => resolve(-1), 5000);
    });
    record(exitCode === 0, "subprocess without key exited cleanly (exit " + exitCode + ")");
  }

  // ── Phase 2: with API key — prove the success path ──
  const { child: child2, started: started2 } = startChild({
    ...baseEnv,
    SIMORGH_API_KEY: API_KEY,
  });
  if (!await started2) {
    record(false, "bun runtime started with API key");
    child2.kill("SIGTERM");
    return 1;
  }
  record(true, "bun runtime started with API key");

  try {
    // 3b. POST /api/v1/agent/execute with token → 200 or honest 502
    {
      const res = await fetch(baseUrl + "/api/v1/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
        body: JSON.stringify({ prompt: "hello" }),
      });
      record(res.status === 200 || res.status === 502,
        "POST /api/v1/agent/execute with token → " + res.status + " (honest, not fabricated)");
    }

    // 4. POST /mcp initialize → protocol version and Mcp-Session-Id
    {
      const res = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" },
          },
        }),
      });
      const sessionId = res.headers.get("Mcp-Session-Id");
      const body = await res.json() as { result?: { protocolVersion?: string }; error?: unknown };
      record(res.status === 200 && !!sessionId && !!body.result?.protocolVersion,
        "POST /mcp initialize → " + res.status + ", protocol: " + (body.result?.protocolVersion ?? "?") + ", session: " + (sessionId ? "yes" : "no"));
    }

    // 5. POST /mcp tools/list → exactly two tools: simorgh_status, simorgh_ask
    {
      const res = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      });
      const body = await res.json() as { result?: { tools?: { name: string }[] }; error?: unknown };
      const toolNames = body.result?.tools?.map((t) => t.name) ?? [];
      const exactMatch = toolNames.length === 2 && toolNames.includes("simorgh_status") && toolNames.includes("simorgh_ask");
      record(exactMatch,
        "POST /mcp tools/list → " + res.status + ", exactly 2 tools: [" + toolNames.join(", ") + "]");
    }
  } finally {
    child2.kill("SIGTERM");
    const exitCode = await new Promise<number>((resolve) => {
      child2.on("exit", (code) => resolve(code ?? 0));
      setTimeout(() => resolve(-1), 5000);
    });
    record(exitCode === 0, "subprocess with key exited cleanly (exit " + exitCode + ")");
    rmSync(workdir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write("\n" + (checks.length - failed.length) + "/" + checks.length + " checks passed\n");
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write("e2e-bun: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}

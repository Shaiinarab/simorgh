// ── The command runner ────────────────────────────────────────────────────────
//
// One method, so tests can assert *what would have been executed* without executing
// anything. That matters more here than usual: the thing being run deploys software,
// and a test that actually shells out to `wrangler deploy` is a test nobody can run
// in CI.

import { spawn } from "node:child_process";

export interface RunResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface Runner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Run a command with `spawn`, never a shell.
 *
 * `shell: false` is the security-relevant choice: plan argv is substituted from
 * operator input (`--service`, `--origin`), and a shell would turn a stray `;` in a
 * service name into a second command. Without a shell, the values stay arguments.
 */
export function childProcessRunner(): Runner {
  return {
    run(command, args, options = {}) {
      return new Promise<RunResult>((resolve) => {
        const started = Date.now();
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          // A fresh env object: `spawn` would otherwise merge process.env implicitly,
          // making a plan look runnable in a test that never set the secrets.
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(options.env ?? {}).filter(([, v]) => v !== undefined)
            ),
          } as NodeJS.ProcessEnv,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({
            command: [command, ...args].join(" "),
            code: -1,
            stdout,
            stderr: `${stderr}${String(error)}`,
            durationMs: Date.now() - started,
          });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            command: [command, ...args].join(" "),
            code: timedOut ? -2 : (code ?? -1),
            stdout,
            stderr: timedOut
              ? `${stderr}\ntimed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
              : stderr,
            durationMs: Date.now() - started,
          });
        });
      });
    },
  };
}

/**
 * A runner that records instead of executing.
 *
 * Ships in `src/` rather than `test/` because the CLI's `--dry-run` uses it: the
 * safest way to prove "we would have run exactly these commands" is to use the same
 * mechanism in the dry run as in the test suite.
 */
export function recordingRunner(outcomes: Record<string, RunResult> = {}): Runner & {
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const key = [command, ...args].join(" ");
      return (
        outcomes[key] ?? {
          command: key,
          code: 0,
          stdout: "(dry run — not executed)",
          stderr: "",
          durationMs: 0,
        }
      );
    },
  };
}

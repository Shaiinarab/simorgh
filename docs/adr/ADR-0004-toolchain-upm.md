# ADR-0004 — upm is the package manager; Node is the only runtime; Bun is gone

- **Status:** accepted (2026-10-03). **Supersedes:** the 2026-10-02 draft of this ADR, which decided
  *against* upm and *for* keeping both the npm lockfile and the Bun host. Both halves were reversed by
  the repository owner after the blocking evidence was laid out, and the migration was then carried out
  and verified. The draft's analysis is kept below under "Why this was hard", because the reasons are
  what shaped the final shape of the change.
- **Decides:** which JavaScript package manager this repository uses, how many runtimes it supports, and
  what happened to the dependency-audit security gate
- **Decided for:** [`upm`](https://github.com/unjs/upm) (MIT, `unjs`, by the Nitro/Nuxt maintainer)
- **Decided against:** npm as an installer, pnpm, Yarn, Bun (as both runtime and package manager)
- **Relates to:** `ADR-0002` (host portability), `ADR-0003` (the capacity layer)

## Decision

1. **`upm` installs; `upm.lock` is the committed lockfile.** No `package-lock.json` exists, and it is
   gitignored so a tool cannot quietly reintroduce a second resolution of the same manifest.
2. **Node is the only JavaScript runtime.** The Bun host is deleted.
3. **The dependency-audit gate is rebuilt, not dropped.** `npm audit` cannot read `upm.lock`, so the
   gate resolves a *throwaway* tree in a temp directory from `package.json` alone and audits that.

## What the migration actually required

The interesting part is not the decision — it is the three things upm needed that this repository did
not have. Each was found by running it, not by reading about it.

### 1. upm cannot read a workspace lockfile (and this repo has no choice)

```
$ upm install
upm: upm does not read workspaces from package-lock.json: delete it to switch to upm (ELOCK)
```

This is not an upm bug; it is the documented behaviour, and it is correct. A lockfile-only install has
no way to know which packages are workspaces. The consequence is that **every dependency had to be
re-resolved from scratch** — the exact step the committed lockfile existed to prevent.

### 2. upm links a workspace into the root only if the root declares it

npm links every workspace into the root `node_modules` unconditionally. upm does not: *"The root only
gets a link to a workspace if it declares that dependency."* So after the first successful install,
`import('@simorgh/phoenix-core')` failed with `ERR_MODULE_NOT_FOUND` — the engine, the entire package,
invisible.

The fix is a real manifest change, not a workaround:

```json
"dependencies": { "@simorgh/phoenix-core": "workspace:*" }
```

`workspace:*` pins it to the local package, so a same-named registry release can never win.

### 3. `simorgh-platform/` was listed as a workspace but has no `package.json`

It is a source directory with its own `tsconfig.json`, not a package: nothing publishes it and nothing
links it. npm tolerated the entry silently. upm reported `1 ws` — the honest count. Listing a
non-package as a workspace was always a lie in the manifest, and it has been removed.

### 4. The audit gate had to be rebuilt

upm refuses to proxy `npm audit` ("npm does not understand upm's `node_modules` layout or `upm.lock`").
The naive reading is "the security gate is gone". It is not gone — `scripts/security-scan.sh` now
resolves a throwaway tree from `package.json` and audits that. Two properties were designed in:

- **It fails closed.** If resolution fails, or reports success without writing a lockfile, the gate
  **fails**. A gate that quietly passes when it cannot check is worse than no gate, because it reports
  safety it never verified.
- **It is the same script locally and in CI**, which is why the `security` job needs no install step
  at all: there is no lockfile to install from, and the audit resolves its own input.

## Verification

Measured on this box, not inferred:

| Check | Before | After |
|---|---|---|
| `upm install` cold (empty store) | — | 339 s, 93 pkgs |
| `upm install` warm (lockfile + store present) | — | **271 ms** |
| `npm install --package-lock-only` (scratch, for the audit) | — | 55 s |
| typecheck (3 configs) | PASS | PASS |
| workerd suite | 93 | **93** |
| node suite | 261 | **261** |
| security gate | PASS | **PASS** (`found 0 vulnerabilities`) |
| `wrangler deploy --dry-run` | PASS | PASS |
| Go build / vet / test | PASS | PASS |

**The load-bearing verification is that both suites are unchanged at 93 and 261 after a complete
`rm -rf node_modules`.** upm skips dependency lifecycle scripts by design, and this toolchain depends
on native binaries — `vitest` transforms through esbuild, `wrangler` runs workerd. That the suite count
is identical is the evidence that skipping lifecycle scripts costs this project nothing. It was the
single largest risk in the migration and it did not materialise.

Note that the engine's own test counts are a poor regression signal on their own: they would be
identical if a whole file had silently disappeared. The file counts (11 workerd, 19 node) are the real
guard, which is why they are recorded in the docs.

## Why this was hard (the draft's analysis, kept)

**upm is a prerelease.** Its README says so in capitals, and it has no `update` command: recovering from
a bad resolution means deleting `upm.lock` and `node_modules` and resolving again.

**It fetches full packuments.** On this box, `wrangler`'s full packument does not arrive through the
proxy at all (several attempts, all timed out), while npm's *abbreviated* one resolves in 10 s and
upm's cold install eventually succeeds in 339 s. If a future resolution stalls, this is the first thing
to suspect, and `--verbose` is where to see it. This is also why the cold-install number is 60× the
warm one and why CI caches `~/.upm/store` rather than `node_modules`.

**Its README documents no proxy support.** Empirically the `http_proxy` on this box *is* honoured, so
this works here. It is not guaranteed elsewhere.

## Consequences

**What it costs**

- Every dependency was re-resolved, so the tree is not byte-identical to the old `package-lock.json`.
  Both suites, typecheck, and the Cloudflare bundle are green on the new resolution, which is the
  strongest statement available without a per-package diff.
- npm remains a **dev dependency of the build** — `npm audit` and `npm i -g upm` in CI. It is no longer
  used to install this project. That is a deliberate, narrow exception, not a loose end.

**What it prevents**

- Two lockfiles. A second resolution of one manifest, with nothing comparing them, is the failure mode
  `ledger.ts` was written to document having already paid for once.
- A second JavaScript runtime. The Bun host was removed, so "run the suite on a third runtime" is no
  longer something a new contributor can do by accident.

**How the Bun removal is recoverable**

`simorgh-platform/src/runtimes/bun.ts` and `simorgh-platform/scripts/e2e-bun.ts` are at commit
`5c53dfe`, and the finding that host produced is recorded and unaffected: **`bun:sqlite` satisfied the
synchronous `SqlPort` with no change to `phoenix-core`**, proving the engine is not Node-shaped. What
was deleted is the artifact, not the conclusion. `ADR-0002` and `docs/HOST-PORTABILITY.md` both say so
at the point where they used to make Bun a live recommendation.

**How this can be revisited**

If upm gains a stable release and an audit story that reads `upm.lock` natively, the scratch-resolve
half of `scripts/security-scan.sh` becomes unnecessary. Until then it is load-bearing, and it is the
one piece of npm this repository keeps.
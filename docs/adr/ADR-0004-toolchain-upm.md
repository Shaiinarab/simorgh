# ADR-0004 — the toolchain stays on npm: upm cannot adopt this repository's lockfile

- **Status:** accepted
- **Date:** 2026-10-02
- **Decides:** which JavaScript package manager this repository uses
- **Decided against:** `upm` ([unjs/upm](https://github.com/unjs/upm)), which was proposed as the
  package manager on the grounds that it is small, fast, MIT-licensed, and written by the maintainer
  of Nitro/Nuxt
- **Amends:** nothing. **Relates to:** `ADR-0003` (the capacity layer), which the toolchain change was
  meant to unblock

## Context

`upm` is a real project, and the proposal was made in good faith. Verified directly against the
repository's own README rather than a third-party description:

| Property | Value | Source |
|---|---|---|
| Repository | `unjs/upm`, MIT | `github.com/unjs/upm` |
| Version installed here | `1.4.0` | `upm --version` |
| Requires | Node.js 22.3+ | README, *Get started* |
| Stability | **"IMPORTANT: Prerelease: upm is not stable yet"** | README, above *Get started* |
| Lockfiles it can *read* | `package-lock.json`, `pnpm-lock.yaml`, `bun.lock` — **"out of the box"** | README, header |
| Lockfiles it *cannot* read | any that **"include workspaces, patches, or git or file dependencies"** | README, *Other package managers' lockfiles* |
| `npm audit` | **not passed through** — *"npm does not understand upm's `node_modules` layout or `upm.lock`"* | README, *npm commands* |
| Lifecycle scripts | **skipped by design** during install | README, *Run scripts* |
| `update` command | does not exist | README, *Add and remove packages* |

Simorgh is `"workspaces": ["phoenix-core", "simorgh-platform"]` — a workspace monorepo — and its CI
security gate is `npm audit --omit=dev` inside `scripts/security-scan.sh`, run identically by a
developer and by the `security` job in `.github/workflows/ci.yml`.

## The blocking finding

The migration was attempted, not assumed away. With a probe copy of the project's `package.json` and
`package-lock.json`:

```
$ upm install
upm: upm does not read workspaces from package-lock.json: delete it to switch to upm (ELOCK)
```

That is the whole problem in one line. upm cannot read a workspace lockfile, and this repository has
exactly one. Switching therefore requires **deleting `package-lock.json`**, and every consequence
below follows from that single deletion.

## Why not

### 1. Adopting it removes the dependency-audit security gate

Not "may weaken it" — removes it. `npm audit` cannot read `upm.lock` or upm's `node_modules` layout,
and upm deliberately refuses to proxy `audit`. So the CI `security` job's dependency half becomes
either an error or, worse, a check that reports nothing and passes.

This repository treats that gate as load-bearing. `AGENTS.md` forbids weakening a security check to
make something pass, and `scripts/security-scan.sh` is deliberately the *same code* in CI and on a
developer's machine. Disabling it to adopt a prerelease package manager is a bad trade, and it is the
kind of quiet capability loss that a green CI badge hides.

The alternative — keep `npm audit` by keeping a `package-lock.json` up to date alongside `upm.lock` —
means maintaining two resolution truths by hand, which is the exact failure mode
`docs/adr/ADR-0001` was written to stop.

### 2. The dependency tree would be re-resolved from scratch

Deleting the lockfile re-resolves every transitive dependency. upm's own defaults change what gets
picked: a **1-day minimum release age**, and lifecycle scripts skipped. Neither can be evaluated here
because the full install did not complete — see *What could not be verified*.

### 3. Skipping lifecycle scripts is an unverified risk for this toolchain

upm skips dependency lifecycle scripts by design, as a supply-chain defence. That defence is
reasonable and this repository would benefit from it. But `vitest` transforms through **esbuild** and
`wrangler` runs **workerd/miniflare**; both ship native binaries that are commonly installed by a
postinstall step. If either needs one, the entire test suite and the Cloudflare bundle stop working —
and that failure would appear on a fresh clone in CI, not here.

### 4. upm is a prerelease with no `update`

The README states it plainly, and there is no `update` command: recovering from a bad resolution means
deleting `upm.lock` and `node_modules` and resolving again, by hand.

## What was verified, and what was not

**Verified on this box, this session:**

- `upm` installs and runs: `npm i -g upm` → `1.4.0`, on Node v26.7.0.
- upm's registry access works: `upm resolve vitest` returned a real tarball URL and integrity hash
  from `registry.npmjs.org`, so the `ENETWORK` seen during the full install was a transient body
  timeout rather than a proxy incompatibility. The `https_proxy` on this box is honoured.
- The `ELOCK` rejection above, reproduced verbatim.

**Not verified — and deliberately not guessed:**

- Whether a from-scratch `upm install` produces a working `vitest` / `wrangler` tree without
  lifecycle scripts. The full resolve timed out before completion, and the documented npm mirror
  (`mirror.atlantiscloud.ir/npm`, per `mailbox/README.md`) is unreachable from this box.
- Whether any dependency in this tree genuinely requires a lifecycle script.

Both are answerable with one successful install on a network that is not timing out. Neither is
answerable by reasoning, and this repository does not guess about its own toolchain.

## Consequences

**What this costs**

- The repository keeps `npm`. upm is installed globally but **not adopted**, so nothing in CI, the
  scripts, or the docs changes.
- The stated strategic benefit — a smaller, faster, script-skipping installer — is forgone for now.

**What this prevents**

- Silently deleting a working lockfile and a working security gate in the same change.
- Recording a migration as done because `upm --version` printed a number.

**How it can be revisited — the unblockers, in order**

1. A successful from-scratch `upm install` on this box, followed by `npm test`, `npm run typecheck`
   and `npm run cf:dry-run` all passing **without** lifecycle scripts. That answers risk 3 with
   evidence rather than argument.
2. A replacement for `npm audit --omit=dev` that understands `upm.lock` — or an accepted decision to
   run the audit in a separate job that installs with npm purely for the audit. Until one of those
   exists, the migration stays blocked, regardless of how good upm is.
3. upm reaching a stable release.

If all three land, this ADR should be superseded rather than amended: the decision was about a
prerelease's limits, and those limits are what would change.

## On the Bun runtime, which this ADR does **not** touch

A migration proposal for `upm` also proposed removing Bun. That is a separate question with a
separate answer, and conflating the two would lose a real result.

`simorgh-platform/src/runtimes/bun.ts` is not a package-manager assumption. It is the third runtime
host that `ADR-0002` explicitly named as the cheap, load-bearing portability test, landed deliberately
in `5c53dfe` from `TASK-010`, and it exists because `bun:sqlite` is a **third SQL dialect**. It is the
thing that proved `SqlPort` is not Node-shaped. The repository has no `bun.lock`, no `bunfig`, no
`bun install`, and no lifecycle script invoking bun — `git grep -i bun` over the tracked tree returns
only documentation, the runtime adapter, its e2e script, and the TASK-010 brief and report.

**Bun stays.** Node is the product runtime and `npm` is the package manager; Bun is an *additional
host* used to test the boundary, exactly as `ADR-0002` intended.
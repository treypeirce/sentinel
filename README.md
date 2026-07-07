# Sentinel

> Governed vulnerability triage — **fix what's reachable, skip what isn't, escalate what's sensitive.**

Sentinel is the judgment layer of an agent-driven remediation pipeline. It takes
a stream of dependency advisories and decides, deterministically, what a coding
agent should do about each one — **before any model is invoked.** The agent only
ever runs on findings routed to `FIX`.

This repo is **Phase 2**: the deterministic scorer + reachability gate + policy
router. The cockpit UI and the Cursor-SDK agent runner build on the `queue.json`
it emits.

```
$ npm run triage

  SENTINEL · governed vulnerability triage
  target acme-payments   entry src/index.ts   scanned 9 deps · 15 files

  PACKAGE             ADVISORY            CVSS        EPSS     REACH   ROUTE
  ──────────────────────────────────────────────────────────────────────────
  node-forge@1.0.0    CVE-2025-12816      8.6 HIGH    0.69%    yes     ! ESCALATE
  jsonwebtoken@8.5.1  CVE-2022-23539      8.1 HIGH    0.48%    yes     → FIX
  marked@0.3.9        CVE-2022-21681      7.5 HIGH    2.7%     no      · SKIP

  Queue  1 FIX   1 ESCALATE   1 SKIP
```

## Why this shape

Most "AI patches your CVEs" tools patch everything a scanner flags. That is the
wrong default: **an unnecessary patch is a new risk**, and most flagged CVEs
aren't reachable in your build. Sentinel inverts it — the deterministic layer
does the heavy lifting, and the agent is the smallest, last, most-governed
component.

Three outcomes, each with evidence:

- **FIX** — reachable on a live call path *and* has a clean upstream fix. Safe
  for an agent to reproduce, patch, and PR (never merge).
- **SKIP** — the vulnerable package is present but not reachable from any
  entrypoint. No action; patching would add change-risk without reducing
  exposure. This is the agent *correctly declining to act*.
- **ESCALATE** — reachable **and** on a sensitive path (money movement, auth,
  crypto). A human signs off; agents don't silently modify code that moves money.

## How it works

```
package-lock.json ──▶ direct dependencies
                          │
        OSV.dev ─────────▶│  advisories  (cached to cache/osv/, offline-capable)
      FIRST.org EPSS ─────▶│  exploit likelihood (cached to cache/epss/)
   src/** import graph ───▶│  reachability (BFS from entrypoint)
      policy.ts rules ────▶│  sensitive-path match
                          ▼
                    route + evidence  ──▶  queue.json
```

- **Scoring** (`src/cvss.ts`): a from-scratch CVSS v3.1 base-score calculator
  (parses the vector, applies the FIRST formula). Combined with EPSS into a
  composite risk (60% severity / 40% exploit likelihood).
- **Reachability** (`src/reachability.ts`): a module-level import graph. A
  package is reachable only if a file on a live path from the entrypoint imports
  it. The evidence is the actual call-path chain.
- **Policy** (`src/policy.ts`): pure predicates over a finding's import sites.
  **This is the "extend it live" surface** — adding a rule (e.g. escalate
  anything under `src/auth/**`) is ~5 lines and re-routes the queue on the next
  run.

## Honest limits

Reachability is a static import graph. It does not resolve reflection, dynamic
`require` of computed names, or build-time injection — which is exactly why
`ESCALATE` exists and why anomalies without a clean verdict go to a human.
(xz-utils was caught by a maintainer noticing sshd ran ~500ms slow, not by any
scanner. Absence of an alert is not proof of safety.)

## Run it

```bash
node -v                       # requires >= 23.6 (native TypeScript, no build step)
npm run triage                # scans ../acme-payments by default (uses cached advisories)
npm run triage -- --target /path/to/repo
npm run triage:refresh        # re-query OSV.dev + FIRST.org and refresh the cache
npm test                      # node:test — CVSS calc, reachability, policy
```

No dependencies. No build. Runs on Node's native TypeScript support; advisory
data is cached under `cache/` so a demo runs with the network unplugged.

## Layout

```
src/
  cli.ts            entrypoint — scan, render, write queue.json
  triage.ts         orchestrator — findings → route + evidence
  lockfile.ts       direct-dependency extraction
  osv.ts            OSV.dev client (disk-cached) → aggregated advisory
  epss.ts           FIRST.org EPSS enrichment (disk-cached)
  cvss.ts           CVSS v3.1 base-score calculator
  reachability.ts   module-level import-graph reachability
  policy.ts         sensitive-path rules  ← extend-live surface
  render.ts         ANSI report
cache/              committed OSV + EPSS snapshots (offline demo)
test/               node:test suites
```

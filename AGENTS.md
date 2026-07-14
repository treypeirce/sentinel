# Sentinel · agent guide

Sentinel is a governed vulnerability-remediation cockpit. Advisory investigator
agents (Cursor cloud, no automatic PR) triage a fleet of services, a human dispatches fix agents,
a reviewer agent audits every fix PR, and a human merges. This file maps the
repo for coding agents making live changes.

## Layout

- `src/agent/modelRouting.ts` — the centralized model policy. Bounded fixes use
  Composer 2.5 Fast; investigations and reviews use Fable 5 High. Model choices
  are catalog-verified and emitted as routing receipts before SDK dispatch.
- `src/cockpit/server.ts` — the whole backend. Serves the cockpit and drives all
  cloud agents. Key spots:
  - `investigatorPrompt()` — the investigator brief. **The routing policy lives
    here in plain English** (money-path list, SKIP/FIX/ESCALATE rules). Policy
    changes are edits to these sentences.
  - `reviewPrompt()` / `runReviewer()` — the reviewer agent brief + dispatcher.
  - `FIX_PROMPT` — the fix agent brief (reproduce with a failing test first).
  - Endpoints: `/api/investigate`, `/api/run-fleet` (dispatch + auto-review),
    `/api/run-review`, `/api/health`, `/api/stream` (replay).
- `src/cockpit/template-fleet.html` — the cockpit UI (single file, inline CSS/JS).
  Rebuild after edits: `npm run cockpit:fleet`.
- `src/cockpit/build-fleet.mjs` — bakes `fleet-queue.json` + `fleet-run.json`
  into `public/fleet.html`.
- `src/cockpit/fleet-run.json` — the recorded replay (real captured runs).
- `fleet.json` — the service manifest (name, local path, repoUrl). Fixture
  repos are SIBLING folders (`../acme-payments` etc.).
- `src/cli.ts` + `src/triage.ts` etc. — the v1 deterministic triage engine.
  Still used to generate `fleet-queue.json` (`npm run triage -- --fleet`).
  No longer the demo's decision-maker; kept as manifest generator + fallback.
- `public/arch.html` — static architecture page, served at `/arch`.
- Guardrail hooks live in each FIXTURE repo, e.g.
  `../acme-payments/.cursor/hooks/guard.mjs` (deny rules) with verifier
  `npm run guardrail:check` run inside that repo.

## Run

```bash
npm run triage -- --fleet    # regenerate fleet-queue.json (service manifest)
npm run cockpit:fleet        # rebuild public/fleet.html from the template
npm run cockpit              # serve http://localhost:4317 (fleet board at /fleet)
```

`CURSOR_API_KEY` env enables live runs; `GITHUB_PAT` (optional) lets the server
post reviewer comments on PRs.

## Rules for changes

- **server.ts edits require a server restart** (Ctrl+C, `npm run cockpit`).
- **template-fleet.html edits require `npm run cockpit:fleet`** then a browser refresh.
- Never auto-merge PRs or push to the fixture repos' main. Agents open draft
  PRs; humans merge. That invariant is the product.
- Verdict enum is exactly `FIX | SKIP | ESCALATE`. The cockpit and dispatch
  logic depend on it.
- Model routing is separate from verdict routing. Change model policy only in
  `modelRouting.ts`; never infer the model from prompt text or repository files.
  Unavailable deep models fail closed rather than downgrade to the easy tier.
- Keep the cockpit's design language: light theme, terse product copy, no
  marketing sentences, no emoji.

# AGENTS.md

Instructions for every coding agent working in this repo: Claude Code, Google Antigravity, OpenAI Codex and GitHub Copilot.

NDAHI Connect is a prepaid community internet platform (Cameroon). Node 20, ES modules, no front-end framework. Four Render services: customer portal, admin, public store, API.

## Current work: the redesign

Read `docs/redesign/README.md` first, then the phase you're working on in `docs/redesign/execution-plan.md`. Product decisions are in `docs/redesign/decisions.md` — don't reopen them in a PR.

## Ground rules

1. **Front end only.** v1 and v2 share the same API, sessions and database. The only server work is the Phase 6 sign-in cutover.
2. **v1 is frozen, not deleted.** New screens go in `customer-app-v2/` and `admin-app-v2/`. Bug fixes still go to v1 and must also be applied to v2 (or the PR says why not).
3. **One area per PR**, one issue per task, one agent per task. Issues are labelled `agent:claude`, `agent:antigravity`, `agent:codex` or `agent:copilot`.
4. **Folder ownership.** Two agents never work in the same folder at the same time. During Phase 2 Antigravity owns `customer-app-v2/`; during Phase 5 Codex owns `admin-app-v2/`. After Phase 1, only Claude Code changes `shared-app/ui/` — others open an issue asking for a component or token.
5. **Use the design kit.** Build screens from `shared-app/ui/` tokens and components (Phase 1). Every user-facing string goes through `shared-app/i18n.js` in English and French.
6. **No hard-coded data.** Placeholders in the designs (`[PRICE]`, `[PLAN 2]`, `[PICKUP LOCATION]`…) come from the API.
7. **Verification is PIN or passkey only.** Never add SMS codes, authenticator apps or recovery codes.
8. **No buying while a bundle is active.** Never add top-up or queued-bundle UI.
9. **No new dependencies** without the owner's approval.

## Commands

```bash
npm ci
npm run check        # syntax checks; add every new .js/.mjs file to this list
npm test             # unit tests
npm run test:browser # all browser journeys
```

Run the journeys that touch your area on **both** variants (normally, then with `?ui=new`).

## Off limits unless the PR is named for it

- `UI_V2_PERCENT`, `UI_V2_OFF` and other env vars in `render.yaml` / `render.staging.yaml` — the owner changes these by hand.
- Authentication code in `lib/` — Phase 6 PRs only, owned by Claude Code.
- `store-app/` — Phase 4 only.
- `migrations/` — not part of the redesign.

## Pull requests

- Open as a draft. Never merge your own PR; the owner merges.
- Include 390 px and 1280 px screenshots for any screen change, and list the journeys you ran.
- Fill in the checklist from "Testing and quality bar" in the execution plan.

## Review guidelines

Reviewers (Codex automatic review, Claude Code on Codex/Copilot PRs) treat these as **blocking**:

- A broken or skipped payment, voucher, hotspot sign-in or store checkout journey, on either variant.
- Any change to authentication, sessions or cookies outside a Phase 6 PR; any SMS or authenticator code path added back.
- Hard-coded prices, plan names, phone numbers or pickup details.
- Changes that alter what production serves by default (v1 must stay the default until the owner ramps).
- Edits to v1 folders that aren't bug fixes, or to another agent's owned folder.
- New dependencies, inline scripts that break the CSP, or new console errors.

Non-blocking, mention briefly: copy tone, minor spacing differences from the design, missing French strings (open a follow-up).

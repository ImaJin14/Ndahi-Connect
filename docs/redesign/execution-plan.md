# NDAHI Connect redesign — execution plan

Exported from the Claude plan doc on 10 Nov 2026. That doc is the original; this copy is what agents work from.

## Goal and ground rules

Ship the redesigned customer portal (with the shop inside), the restyled admin and PIN-or-passkey sign-in in eight phases. Each phase lands behind a switch, so today's design keeps running until the new one has proven itself on real traffic.

- **Front end only, with one exception.** v1 and v2 call the same API, sessions and database. The only server work is the sign-in cutover in Phase 6, which uses the migration and authenticator-retirement code already in `lib/`.
- **v1 is frozen, not deleted.** New screens live in `customer-app-v2/` and `admin-app-v2/`. Bug fixes still go to v1 until cleanup.
- **The public store stays.** `store-app` keeps serving guests at store.ndahiconnect.net. The portal's Shop tab is the signed-in path.
- **One area per PR.** Small reviewable PRs, each with its journey tests green for both variants.
- **Design source of truth.** The design canvas (about 65 screens). Placeholders such as `[PRICE]` and `[PICKUP LOCATION]` become real data from the API, never hard-coded text.

## Phases at a glance

Phase order (S = one PR, M = a handful, L = a series):

- **Phase 0** Groundwork (S) → **Phase 1** Design system in code (M)
- After Phase 1, two tracks run in parallel:
  - Customer: **Phase 2** Customer shell and everyday screens (L) → **Phase 3** Get-connected flows (L) → **Phase 4** Shop inside the portal (M)
  - Admin: **Phase 5** Admin v2 (L)
- **Phase 6** Sign-in cutover (M) starts after Phases 3 and 5. It is the only phase that changes server code.
- **Phase 7** Rollout, hotspot pages, cleanup (M) starts after Phases 4 and 6.

Phases 0 and 1 come first because everything else is built on them. After that the customer track (2 → 3 → 4) and admin (5) can run in parallel. The sign-in cutover waits for both, and rollout waits for everything. Sizes are relative: S is a single PR, M a handful, L a series.

## Phase 0 — Groundwork (size: S)

Production must look identical after this phase. Only the plumbing for v2 is added.

1. **Rollout switch.** `static-server.mjs` serves `customer-app/` or `customer-app-v2/` per visitor. Controls: the `ndahi_ui` cookie, `?ui=new` / `?ui=old`, `UI_V2_PERCENT` (starts at 0) and the `UI_V2_OFF` kill switch. This is the Claude Code prompt already written; v2 starts as an exact copy of v1.
2. **Variant tag.** Add v1/v2 to performance metrics and logs, so payment completion and errors can be compared.
3. **Design exports.** Export every canvas screen as PNG into `docs/redesign/screens/png/` (phone and desktop), named like the artboards. Claude Code can't open the canvas, so these are its reference.
4. **Cross-origin check.** The portal will call store endpoints that today only expect the store origin (`STORE_APP_URL` in `lib/api/middleware.mjs`). Confirm CORS and `customer_session` work from portal.ndahiconnect.net. Fix it here if they don't.
5. **Staging.** Deploy to the services in `render.staging.yaml` and run every browser journey with `?ui=new`.

**Done when:** defaults leave production unchanged, `?ui=new` serves the copy on staging, and both variants pass `npm test` and the journeys.

## Phase 1 — Design system in code (size: M)

One shared set of styles and building blocks replaces the three hand-written stylesheets. Every later screen is assembled from it.

- **Tokens** in `shared-app/ui/tokens.css`:
  - colours: forest `#003b2b`, lime `#b9ee2e`, ivory, paper, ink, muted `#5c6963`, line, sage, and the four status tints;
  - type: Playfair Display headings, DM Sans body;
  - spacing, radii and focus ring.
- **Components** as small ES modules + CSS, no framework:
  - buttons (primary, secondary, danger), cards, status pills;
  - form fields with labels and errors, PIN input with show/hide;
  - phone tab bar, desktop header, admin side menu;
  - segmented control, switch, step progress, empty and error states, bottom action bar, success / waiting screens.
- **Bilingual from the start.** Every string goes through `shared-app/i18n.js` (EN and FR).
- **Accessibility baseline:** 44 px touch targets, 4.5:1 text contrast, visible focus, labelled controls. The canvas already follows this.
- **Style reference page** `customer-app-v2/ui-kit.html` shows every component. Staging only, never linked.

**Done when:** the kit page matches the canvas at 390 px and 1280 px, in both languages, with zero console errors.

## Phase 2 — Customer shell and everyday screens (size: L)

Signed-in customers get the five-tab portal: Home · Internet · Shop · Activity · Account. This phase ships the four tabs that already have data behind them. Shop gets its own phase.

1. **Navigation.** Replace `portal-nav.js` with the new tab bar (phone) and header (desktop). Keep the existing hash routes so old links still land somewhere sensible.
2. **Home.** Bundle card (data left, end date, devices), quick actions, one shop suggestion, recent activity.
3. **Internet.** Bundles and Vouchers tabs:
   - active bundle and bundle history;
   - saved voucher with QR and print slip.
   - It states the rule from `billing-terms.html`: no buying while a bundle is active.
4. **Devices.** List, disconnect, pairing code, review incoming requests. Uses the existing `wifi-pairing` and `device-management` APIs.
5. **Activity.** One list of bundle payments, vouchers and shop orders, with an All / Internet / Orders filter. Includes receipt detail with PDF download.
6. **Account.**
   - Main page: profile, notification switches, language, NDAHI Home, help, sign out.
   - Sub-screens: edit profile, change PIN, passkeys, signed-in devices.
7. **Supporting pages.** Notifications inbox, Help with connection check, payment rules, NDAHI Home router.
8. **Desktop layouts.** Home, Internet, Activity and Account at 1280 px.

**Done when:** a signed-in customer can do everything v1 allows from these screens, and the portal, active-bundle, notification and home journeys pass on v2.

## Phase 3 — Get-connected flows (size: L)

These are the screens that turn a visitor into a paying, connected customer. Each one maps to an existing page, so the work is mainly restyling plus a few flow changes.

| New screen | Replaces in v1 | Change beyond the look |
| --- | --- | --- |
| Hotspot landing | `hotspot.html` | Four clear choices: account, voucher, bundle from another phone, buy |
| Sign in | `login.html` | PIN or passkey only; no SMS step |
| Finish Wi-Fi sign-in | `wifi-connected.html` | Now follows sign-in directly |
| Buy a bundle | `onboarding.html` | Plan → pay → waiting for approval → online, in one screen |
| Use a voucher | `voucher-connect.html` (code entry) | None |
| Scan to connect | `voucher-connect.html` (QR) | Checks for an active bundle first; none → Buy a bundle, then connects without a second scan |
| Saved voucher | `voucher-ready.html` | None |
| New device request | `pair.html`, `pair-review.html` | Matching reference shown on both screens |
| Forgot PIN | `forgot-pin.html` | None (email link, 15 minutes, single use) |

Scan to connect needs one API answer that may not exist yet: whether the scanned account has an active bundle, before PIN entry. Check `lib/api/vouchers.mjs` first. If it's missing, add a read-only field to the existing voucher-check response, not a new endpoint.

**Done when:** the hotspot, sign-up, captive-completion, voucher-delivery, pending-payment and pairing journeys pass on v2, including on a real phone joined to NDAHI Wi-Fi.

## Phase 4 — Shop inside the portal (size: M)

Signed-in customers buy devices from the Shop tab with their details filled in. Guests keep the public store. Both use the same store API and orders.

1. **Shop tab:**
   - product list with category filter (phone) and grid (desktop);
   - product page with quantity;
   - checkout: details from the account, pickup, MoMo / Orange Money → waiting → order placed.
2. **Orders in Activity.** Store orders appear next to bundle payments. The order page shows progress, the collection code, receipt and help.
3. **Public store.** `store-app` stays at store.ndahiconnect.net for guests. Restyle it with the shared tokens from Phase 1 so it matches, and apply the guest flow changes from the canvas:
   - guest or sign-in choice;
   - Mobile Money number plus optional email;
   - private tracking link to copy or bookmark — no SMS.
4. **Order ownership.** Keep the existing "claim order" behaviour: a guest who later signs in with the same number sees the order in Activity.

**Done when:** a signed-in purchase and a guest purchase both reach "Ready to collect" and "Collected" on staging, and the store, initial-catalogue and cash-collected checks pass.

## Phase 5 — Admin v2 (size: L)

Admin keeps its own app, domain and session, so the security separation stays as it is. Staff opt in with `?ui=new`; there's no percentage rollout for a handful of people.

1. **Shell.** Grouped side menu (Network · Sales · People · System), home with "Needs attention", role rules from `navigation.js` kept (store for owner/operator, network setup for owner).
2. **Daily screens first:** Payments, Store orders (prepare → collection code check → handed over, owner-only refund with confirmation), Products and stock, Vouchers and batch printing.
3. **Then the rest:**
   - Network: Customers and customer detail, Bundles and bundle edit, Live devices, Connections.
   - Money: Resellers ledger, Cash & settlements.
   - Owner and system: Network setup wizard, Home routers, Audit log, Profile & security.
4. **Admin sign-in screens** come in Phase 6 together with the server change.

**Done when:** staff run a full week of operations on v2 without falling back to v1, and the admin-app, voucher-print, reseller and cash journeys pass.

## Phase 6 — Sign-in cutover to PIN and passkey (size: M)

This is the one server-side change. The groundwork exists already: `lib/authentication-migration.mjs` reports readiness, and `lib/authenticator-retirement.mjs` removes TOTP secrets, recovery codes and the customer, admin and OTP challenge collections.

1. **Enrol before removing.** v1 and v2 both prompt anyone without a PIN or passkey to set one at next sign-in. Admins must register at least one passkey.
2. **Watch readiness.** Use the existing readiness report: who still depends on SMS codes or an authenticator. Contact the stragglers.
3. **Cut over.**
   - Run the retirement script on staging, then production after a backup.
   - Remove `verify.html`, `authenticator-management.js` and the admin MFA step from v1, so neither variant offers SMS or authenticator codes.
4. **Admin sign-in.** Ship the new two-step screen: email + PIN, then passkey.
5. **Recovery path.** Customers reset a forgotten PIN by email link. Admins with a lost passkey get it removed by the owner, then register a new one.

**Done when:** the readiness report shows no account depending on SMS or an authenticator, the retirement has run, and the authentication journeys pass with PIN and passkey only.

## Phase 7 — Rollout, hotspot pages, cleanup (size: M)

v2 reaches every customer step by step, with a one-switch rollback at each step.

1. **Ramp the customer portal:**
   - Raise `UI_V2_PERCENT` from 10 to 50 to 100, holding at least 3 days per step.
   - Before each step, compare v2 against v1: payments confirmed out of payments started, vouchers activated, front-end errors and CSP reports, support contacts.
   - Anything worse: set `UI_V2_OFF=true` and fix before ramping again.
2. **Hotspot pages on the routers.** These are copied onto MikroTik routers, so the cookie switch can't reach them. Update one hotspot first, run it for a week, then the rest.
3. **Admin.** Switch staff to v2 by default once Phase 5's "done when" is met.
4. **Cleanup,** two weeks after 100% with no rollback:
   - Delete `customer-app/` and `admin-app/` v1 and rename the v2 folders.
   - Remove the switch, cookie and env vars, and drop the v1 entries from `npm run check`.

## Testing and quality bar

Every PR meets the same bar before merge. Most of it already exists in the repo.

- [ ] `npm run check` and `npm test` pass; new files are added to the `check` list
- [ ] Affected browser journeys pass on **both** v1 and v2
- [ ] Screens compared against the matching screen in `docs/redesign/screens/` at 390 px and 1280 px; differences either fixed or noted in the PR
- [ ] English and French both checked
- [ ] Keyboard-only run-through and contrast check on new components
- [ ] Zero browser console errors and no new CSP reports
- [ ] Tried on a real low-end Android phone on NDAHI Wi-Fi for anything in Phase 3
- [ ] Defaults still leave production on v1

## Risks and decisions still needed

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Service worker serves the other variant's cached files | Broken or mixed screens after switching | Variant in the cache name; covered in Phase 0 |
| Portal can't call store endpoints | Shop tab checkout fails | CORS and session check in Phase 0, before any shop work |
| Customers locked out at sign-in cutover | Support load, lost sales | Enrol first, cut over only when the readiness report is clean |
| Hotspot pages on routers drift from portal | Inconsistent first impression | One-router pilot, then all, in Phase 7 |
| v1 bug fixes not carried into v2 | Regressions at 100% | Every v1 fix PR also patches v2, or says why not |

Decisions needed from you before the phase that uses them:

- **Phase 2:** real plan names and prices to replace `[PLAN 1–4]` and `[PRICE]`; these come from admin, so they just need entering.
- **Phase 3:** the support phone and WhatsApp number for Help.
- **Phase 4:** pickup location and opening hours, product photos, warranty wording.
- **Phase 5:** reseller commission rate shown on the ledger.

## How to drive each phase with Claude Code

One prompt per PR, built the same way each time, keeps the work reviewable and stops scope creep.

1. **Context.** Point at the repo files the area touches, the matching screens in `docs/redesign/screens/`, and this plan's phase.
2. **Scope.** Name the screens and say what stays untouched (v1 folders, `lib/api`, store-app unless Phase 4).
3. **Rules.** Use only Phase 1 components and tokens, run strings through `i18n.js`, and use no new dependencies.
4. **Proof.** Run `npm run check`, `npm test` and the named journeys on both variants, then attach 390 px and 1280 px screenshots to the PR.
5. **Stop.** Open the PR and stop; never change `UI_V2_PERCENT`.

Suggested PR sequence:

- **Phase 0:** rollout switch.
- **Phase 1:** tokens and components; kit page.
- **Phase 2:** shell and Home; Internet; Devices; Activity and receipt; Account and sub-screens; supporting pages; desktop layouts.
- **Phase 3:** hotspot and sign-in; buy bundle; voucher and saved voucher; scan to connect; pairing; forgot PIN.
- **Phase 4:** Shop tab; orders in Activity; public store restyle.
- **Phase 5:** admin shell; daily screens; remaining screens.
- **Phase 6:** enrolment prompts; cutover.
- **Phase 7:** rollout and cleanup.

## Four agents, one repo

Claude Code leads and owns the risky, cross-cutting work. Antigravity builds screens it can check visually, Codex reviews every PR and takes parallel well-scoped tasks, and Copilot handles small issues. One shared `AGENTS.md` keeps all four following the same rules, and each task gets one owner so they never edit the same files at once.

| Tool | Best used here for | Owns |
| --- | --- | --- |
| Claude Code | Cross-cutting changes that need the whole repo in view | Phase 0 switch, Phase 1 design kit, Phase 3 get-connected flows, Phase 6 sign-in cutover, writing the issue for every other task |
| Google Antigravity | Building screens and checking them in its browser against the design PNGs, with screenshots as proof | Phase 2 customer screens and desktop layouts, Phase 4 Shop tab and public store restyle |
| OpenAI Codex | Automatic review of every PR; parallel cloud tasks with clear specs | Reviewer on all PRs; Phase 5 admin screens; French strings; journey-test updates |
| GitHub Copilot | Small issues assigned on GitHub; autocomplete while you edit | Copy and placeholder fixes, accessibility fixes, porting v1 bug fixes into v2 |

### Rules that keep them from colliding

1. **One task, one issue, one branch, one agent.** Label each issue `agent:claude`, `agent:antigravity`, `agent:codex` or `agent:copilot`, and link it to its phase.
2. **Folder ownership per phase.** While Phase 2 runs, Antigravity owns `customer-app-v2/`; while Phase 5 runs, Codex owns `admin-app-v2/`. Two agents never work in the same folder at the same time.
3. **The design kit has one owner.** After Phase 1, only Claude Code changes `shared-app/ui/`. The others open an issue asking for a component or token.
4. **Nobody reviews their own work.**
   - Codex reviews every PR automatically.
   - Claude Code also reviews the PRs that Codex and Copilot write.
   - You approve and merge.
5. **CI is the referee.** The testing checklist above applies to every agent's PR. A failing journey blocks the merge, whoever wrote it.
6. **Off limits to everyone except named PRs:**
   - `UI_V2_PERCENT` and `render.yaml` env vars — you change these by hand.
   - Auth code in `lib/` — only the Phase 6 PRs, owned by Claude Code.

### Setup, added to Phase 0

- [ ] Write `AGENTS.md` at the repo root.
  - Contents: the ground rules, folder layout, commands (`npm run check`, `npm test`, journeys), the off-limits list, and a review-guidelines section.
  - Review guidelines must name what counts as blocking, such as a broken payment journey, auth changes or hard-coded prices. By default Codex flags only the most severe issues.
- [ ] Point `CLAUDE.md` at `AGENTS.md` instead of duplicating it. Antigravity and Copilot both read `AGENTS.md`.
- [ ] Turn on Codex automatic reviews for the repo.
- [ ] Turn on the Copilot coding agent so issues can be assigned to it.
- [ ] Install the Antigravity Chrome extension so its browser agent can screenshot screens on staging.
- [ ] Add a GitHub issue template per phase with the five parts from "How to drive each phase".

### Who leads each phase

| Phase | Lead | Support |
| --- | --- | --- |
| 0 Groundwork | Claude Code | Codex review |
| 1 Design kit | Claude Code | Antigravity checks the kit page visually |
| 2 Customer core | Antigravity | Copilot for small fixes; Codex review |
| 3 Get connected | Claude Code | Antigravity for screen polish |
| 4 Shop in portal | Antigravity | Claude Code for the store API and session work |
| 5 Admin v2 | Codex | Copilot for small fixes; Claude Code review |
| 6 Sign-in cutover | Claude Code | Codex review |
| 7 Ramp + cleanup | Claude Code | Copilot ports late v1 fixes |

Sources: [Antigravity reads AGENTS.md](https://thepromptshelf.dev/blog/google-antigravity-agents-md-rules-guide-2026) · [Antigravity browser agent and artifacts](https://rkalani1.github.io/agent-builder-field-guide/platforms/antigravity/) · [Codex reviews and tasks on GitHub](https://codex.danielvaughan.com/2026/04/16/codex-as-github-coding-agent-agent-hq-model-selection-cloud-review/) · [Copilot coding agent reads AGENTS.md](https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions)

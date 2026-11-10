---
name: Redesign task
about: One PR-sized task from the redesign execution plan
title: "[Phase N] "
labels: redesign
---

<!-- Add one agent label: agent:claude, agent:antigravity, agent:codex or agent:copilot -->

**Phase:** <!-- 0–7, link to the section in docs/redesign/execution-plan.md -->

## Context
<!-- Repo files this touches, the matching screens in docs/redesign/screens/, and the plan section. -->

## Scope
<!-- Screens or changes in this PR. What stays untouched (v1 folders, lib/api, store-app unless Phase 4). -->

## Rules
- Use only `shared-app/ui/` tokens and components; strings through `shared-app/i18n.js` (EN + FR).
- No new dependencies. No hard-coded prices, plans or contact details.
- Follow `AGENTS.md`.

## Proof
- [ ] `npm run check` and `npm test` pass
- [ ] Journeys: <!-- name them --> pass on v1 and with `?ui=new`
- [ ] Screenshots at 390 px and 1280 px attached
- [ ] Keyboard and contrast checked on new components

## Stop
Open a draft PR and stop. Never change `UI_V2_PERCENT`.

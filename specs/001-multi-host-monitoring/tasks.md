---
description: "Tasks for the multi-host monitoring feature"
---

# Tasks: Multi-Host Monitoring

**Input**: Design documents from `/specs/001-multi-host-monitoring/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Verification is by the project's established method (headless renders against synthetic data; local fake-log runs; per-host dry runs). No unit-test framework is introduced.

**Organization**: Grouped by user story so each can be delivered on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1 summary page, US2 add-a-host, US3 per-host permissions, US4 compare hosts

## Phase 1: Setup

- [ ] T001 Read-only survey of curator.reactome.org per quickstart step 1; record results in an internal note (not in the repo); fill the row in research.md with non-sensitive facts only (OS family, has `%{ms}T`, shares role yes/no)
- [ ] T002 [P] Read-only survey of the Plant Reactome host (`plant-reactome-host`); same recording rules; confirm systemd, `setfacl`, Python and AWS CLI versions, instance role name
- [ ] T003 [P] Decide CPWS in/out per the spec's assumptions; record the decision in research.md

**Checkpoint**: unknowns table in research.md filled

---

## Phase 2: Foundational

- [ ] T004 `collector/install.sh`: add prerequisite checks (systemctl, python3 ≥ 3.8, aws, setfacl) that stop with a clear message naming the missing tool and the package to install on Ubuntu and Amazon Linux
- [ ] T005 [P] `collector/install.sh`: verify the instance role can be resolved (`aws sts get-caller-identity`) and warn if not, without aborting
- [ ] T006 [P] `site/app.js`: sort `state.hosts` by `order` (stable), give each section `id="host-<name>"`
- [ ] T007 Run the local fake-log suite (`scratchpad` recipe in README) and a `--state-dir` dry run on reactome.org to confirm no regression from T004–T006

**Checkpoint**: install script and page accept multiple hosts without behaviour change for one host

---

## Phase 3: User Story 1 — One page, every system (P1) 🎯 MVP

**Goal**: two or more hosts render as sections with a summary row; pill reflects the worst.

**Independent Test**: synthesize `site/data/<second-host>/` from reactome.org data with an injected outage, list both in a test `hosts.json`, render headless: two sections, summary row with two chips, pill "Problems detected".

- [ ] T008 [US1] `site/app.js`: `renderHostSummary()` — chips with title, state dot and anchor link; shown only when `state.hosts.length > 1`; re-rendered with the pill
- [ ] T009 [P] [US1] `site/style.css`: summary row styles (chips reuse `.pill` look; wraps on narrow screens; respects both themes)
- [ ] T010 [US1] `site/app.js`: response-time chart empty state "no timing data for this host" when no point in the window has a p95 (data-model.md `noTiming`)
- [ ] T011 [US1] Headless test with two synthetic hosts (healthy + silent, healthy + no-timing) in all three ranges; screenshot review in light and dark; record time-to-render with 10 Mbit/s / 50 ms throttling (SC-002)
- [ ] T012 [US1] `infra/deploy.sh site`; live render check

**Checkpoint**: page ready for a second host's data

---

## Phase 4: User Story 2 — Add a host without new code (P1)

**Goal**: curator.reactome.org and Plant Reactome reporting, following only quickstart.md.

**Independent Test**: each host appears with a complete section within ten minutes of `install.sh`, with zero unparsed log lines.

- [ ] T013 [US2] `collector/config/curator.reactome.org.json` from the T001 survey (units, probes, log path/groups, expected restarts)
- [ ] T014 [P] [US2] `collector/config/<plant-reactome-host>.json` from the T002 survey
- [ ] T015 [US2] Dry-run each config on its host with `--state-dir /tmp/status-test --no-upload --print`; fix config until `ok` and `unparsed == 0`
- [ ] T016 [US2] Stage and have the operator run `install.sh` on curator; confirm `data/curator.reactome.org/latest.json` is served
- [ ] T017 [US2] Same for Plant Reactome (after T020 grants its role)
- [ ] T018 [US2] `site/hosts.json`: add both entries with `order`; `infra/deploy.sh site`; live check of sections and summary row
- [ ] T019 [US2] README: replace "Adding another host" with quickstart.md content; note the shared-role exception

**Checkpoint**: three hosts live

---

## Phase 5: User Story 3 — A compromised host cannot fake another (P2)

**Goal**: hosts with their own role can write only their own prefixes.

**Independent Test**: from Plant Reactome, `aws s3 cp` to `data/reactome.org/x` is denied; to `data/<own>/x` succeeds (then delete the test object).

- [ ] T020 [US3] `infra/status-site.yaml`: `HostRoles` parameter (`host=role,host=role`) and a per-host managed policy (PutObject on `data/<host>/*`, `raw/<host>/*`; ListBucket with `s3:prefix` condition on those two prefixes) attached to the named role; keep the shared policy for `EC2CloudwatchAgentRole`
- [ ] T021 [US3] `infra/deploy.sh`: pass `HOST_ROLES` env var through to the parameter; document in README
- [ ] T022 [US3] Deploy the stack; run the independent test from Plant Reactome; record the shared-role exception for curator in research.md and README

**Checkpoint**: permission model matches the spec

---

## Phase 6: User Story 4 — Compare hosts in the enlarged view (P3)

- [ ] T023 [US4] `site/app.js`: host `<select>` in the enlarged view controls when `state.hosts.length > 1`; switching calls `openModal` with the other host's key and the same range/window; `writeHash` already encodes the key
- [ ] T024 [US4] Headless test: open enlarged chart, switch host, confirm subtitle host name and data change; copy-link round trip

---

## Phase 7: Polish

- [ ] T025 [P] Adversarial review round focused on multi-host: page with a host list of 0, 1, 4 and 20 entries; a host whose prefix 404s; duplicate names; time-to-render for 4 hosts under throttling must stay under 3 s (SC-002)
- [ ] T026 [P] Update `.specify/memory/constitution.md` Constraints if the data layout or permission model changed
- [ ] T027 Run `/speckit-converge` against this feature and fix or file anything it lists

## Dependencies

- Phase 2 before any story. US1 before US2 (the page must handle two hosts before a second host reports). T020 before T017. US4 after US1.
- T001–T003 are read-only and can start immediately.

## Parallel Example

- T002 and T003 alongside T001; T009 alongside T008; T014 alongside T013.

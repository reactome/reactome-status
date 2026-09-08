---
description: "Delivered work for the status page baseline, followed by convergence findings"
---

# Tasks: Status Page Baseline

**Input**: `specs/000-status-page-baseline/` (spec.md, plan.md)

**Organization**: what was delivered, grouped by the spec's user stories; every item below was completed and deployed by 2026-09-04. Convergence phases appended by `/speckit-converge` list any gap between this spec and the code.

## Phase 1: Collector (US1, US4)

- [x] T001 [US1] `collector/collector.py`: systemd unit state and start times with transient-state settling; HTTP/TCP probes without redirect following; Apache mod_status; host load, memory, disk (df formula)
- [x] T002 [US1] `collector/collector.py`: linear escape-aware access-log parser; offset state; rotation carry-over by inode; per-line failure counted, never fatal
- [x] T003 [US1] `collector/collector.py`: SQLite points (one per slot), rollups with per-key counts and unrounded fractions, series 24h/7d/90d, events, raw archive; pruning by row count; corruption quarantine; atomic writes
- [x] T004 [US1] `collector/collector.py`: public-safe snapshot (no URLs, ports, versions, paths); restart and recovery events; expected restarts
- [x] T005 [US4] `collector/install.sh`, `uninstall.sh`, unit and timer: dedicated user/group, ACL on the log directory, timer at *:1/5, hardening, prerequisite-safe upgrades, version print; root and unsafe-test refusals in the collector

## Phase 2: Page (US1, US2, US3)

- [x] T006 [US1] `site/app.js`: per-host sections, staleness banner and pill from each host's interval, error isolation per host, last-good data on fetch failure, clock-skew correction, fetch timeouts
- [x] T007 [US3] `site/app.js`: time-weighted uptime with missing samples as down, bins by time overlap, minutes-down colouring, floored percentages
- [x] T008 [US2] `site/app.js`: seven charts with the x-axis pinned to the range, gap breaking, legend chips (toggle, solo, all/none) remembered per host and chart, tooltips built from DOM nodes
- [x] T009 [US2] `site/app.js`: enlarged view with its own range, custom window, CSV download, shareable link; theme toggle with pre-paint script
- [x] T010 [US1] `site/index.html`, `style.css`: Reactome branding, self-hosted Roboto, alpha notice, noindex, accessible controls

## Phase 3: Infrastructure (US1, US4)

- [x] T011 `infra/status-site.yaml`: versioned private bucket with lifecycle rules; CloudFront with `site/` origin path and a separate uploads origin; forced-JSON function and sandbox CSP for `data/*`/`raw/*`; path-only cache policies; security headers; upload policy on the hosts' role
- [x] T012 `infra/deploy.sh`: certificate request, stack deploy, site sync to `site/`, region pinning, empty-changeset tolerance

## Phase 4: Verification

- [x] T013 Six adversarial review rounds (security, operations, numerical, page) with reproductions; all verified findings fixed and deployed

## Phase 5: Convergence

Assessed 2026-09-08 against spec.md, plan.md and the constitution (10 principles checked; 14 functional requirements, 5 success criteria and 12 acceptance scenarios checked). Findings: 3 partial, 1 unrequested; 0 contradicts, 0 missing.

- [ ] T014 Scope each host's upload permission to its own `data/<host>/*` and `raw/<host>/*` per Constitution IV (partial) — HIGH; today the shared instance role may write under all of `data/*`; delivered by `specs/001-multi-host-monitoring` T020 for hosts with their own role, with the shared-role exception documented
- [x] T015 Reduce collector peak memory below 100 MB with 91 days of history per SC-003 (partial) — MEDIUM; measured 209 MB because `rollup()` materialises every stored row before bucketing; stream rows and merge one bucket at a time — done in 0.5.2: 209 MB → 35 MB
- [x] T016 Make the CSV export match "download the shown data" per FR-011 (partial) — LOW; it currently includes hidden series; export only the series currently shown — done
- [x] T017 Remove or justify the unused `docker_containers` code path in `collector/collector.py` (unrequested) — LOW; the unit deliberately has no Docker access, so the path cannot work as shipped — removed in 0.5.2

# Implementation Plan: Multi-Host Monitoring

**Branch**: `001-multi-host-monitoring` | **Date**: 2026-09-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-multi-host-monitoring/spec.md`

## Summary

Bring curator.reactome.org, Plant Reactome and (if eligible) CPWS onto the status page. The
collector and data layout already support any number of hosts; the work is (1) a per-host survey
and config, (2) per-host upload permissions where the host has its own instance role, (3) a
small page change for a host summary row and a "no timing data" state, (4) an install script
that checks prerequisites and copes with a second Linux distribution, and (5) a documented
add-a-host procedure. Optional P3: a host selector in the enlarged chart view.

## Technical Context

**Language/Version**: Python 3.8+ on the hosts (distribution-provided), ES2020 JavaScript (page)

**Primary Dependencies**: standard library + AWS CLI v2 on hosts; vendored uPlot 1.6.32 on the page; CloudFormation

**Storage**: SQLite per host (local); S3 bucket `status.reactome.org` with `data/<host>/` and `raw/<host>/`

**Testing**: local fake-log runs of `collector.py --state-dir`; headless Chrome renders of the page against synthesized multi-host data; dry-run on each host before install

**Target Platform**: systemd Linux hosts with an EC2 instance role; static page on CloudFront

**Project Type**: monitoring agent + static web page + IaC

**Performance Goals**: page renders four hosts in under 3 s; collector run under 2 CPU-s per host

**Constraints**: constitution principles I–X; no new frameworks; public repository

**Scale/Scope**: 3–4 hosts, ~10 services and ~12 checks each

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I Independent of what it monitors | Each host pushes; page reads only S3 | PASS |
| II Missing data is downtime | Staleness and expected samples follow each host's own interval | PASS (verify per-host interval path in `uptime()`) |
| III Only aggregates leave a host | New hosts use the same scrubbed snapshot | PASS; survey stays out of the repo |
| IV Least privilege | Per-host roles where they exist; shared-role exception documented | PARTIAL — hosts sharing the production role keep prefix-wide access; see baseline T014 |
| V Uploaded content is inert | Unchanged | PASS |
| VI Never sample on the minute | Same timer on every host | PASS |
| VII Linear parsing | Same parser; a different LogFormat degrades gracefully | PASS (FR-004 makes the degradation visible) |
| VIII Fail loud, recover alone | Unchanged; install checks prerequisites | PASS |
| IX Honest numbers | "no timing data" label; per-host resolution labels | PASS |
| X Verified before deployed | Dry-run per host, headless render with synthetic hosts | PASS |

No violations; Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-host-monitoring/
├── plan.md              # This file
├── research.md          # Phase 0: decisions and per-host unknowns
├── data-model.md        # Phase 1: host list, host config, upload role
├── quickstart.md        # Phase 1: the add-a-host procedure (source for README)
└── tasks.md             # Phase 2
```

### Source Code (repository root)

```text
collector/
├── collector.py                     # unchanged unless a host needs a new probe kind
├── config/
│   ├── reactome.org.json
│   ├── curator.reactome.org.json    # new
│   ├── <plant-reactome-host>.json   # new; hostname confirmed by the T002 survey
│   └── <cpws-host>.json             # new, if eligible
├── install.sh                       # prerequisite checks, distro tolerance
└── uninstall.sh
site/
├── hosts.json                       # one entry per host, with order
├── app.js                           # summary row; "no timing data"; optional host selector in modal
└── style.css                        # summary row styles
infra/
└── status-site.yaml                 # PerHostUploadPolicy (data/<host>/*, raw/<host>/*) for hosts with their own role
README.md                            # "Adding a host" section rewritten from quickstart.md
```

**Structure Decision**: existing single-repo layout; no new directories beyond one config file per host.

## Phase 0: Research → research.md

Unknowns to resolve, each by a read-only survey of the host (results recorded in an internal
note, not in the repository):

1. curator.reactome.org: OS, Python and AWS CLI versions, instance role, services (Tomcat? Neo4j? curator tool), Apache log path and LogFormat, ports bound.
2. The Plant Reactome host: same list; it is a separate instance, possibly a different distribution; confirm systemd, `useradd` flags, ACL support, `setfacl` availability, AWS CLI path.
3. CPWS: where it runs and whether it meets the assumptions; decide in or out.
4. Which hosts share the production instance role and which have their own instance profile (recorded in the private survey note).
5. Whether any host's Apache log lacks `%{ms}T`.

Decisions already taken (see research.md): one bucket and one page; per-host prefixes; per-host
managed policy attached to each host's own role; hosts sharing a role keep the shared policy.

## Phase 1: Design → data-model.md, quickstart.md

- Host list schema gains `order` (integer) and keeps `name`, `title`, `prefix`.
- Page: `renderHostSummary()` builds the summary row from `state.hosts` and each section's
  `dataset.status`; sections get `id`s for anchors; `renderCharts()` labels the response-time
  chart "no timing data" when no point in the window carries a p95.
- Install script: `require_cmd systemctl python3 aws setfacl`, Python version check, instance
  identity check (`aws sts get-caller-identity` succeeds), and a hint for common distributions'
  package names when something is missing.
- Page: the events table's "checked every N min" wording uses the host's interval.
- CloudFormation: per-host managed policies generated with `Transform: AWS::LanguageExtensions`
  and `Fn::ForEach` over a `HostRoles` parameter (`host=role` entries, comma-separated); the
  existing shared policy remains for the shared role. (Plain CloudFormation cannot loop over a
  parameter; the transform is the documented way.)
- quickstart.md is the operator procedure and becomes the README section.

## Phase 2: Tasks → tasks.md (generated by `/speckit-tasks`)

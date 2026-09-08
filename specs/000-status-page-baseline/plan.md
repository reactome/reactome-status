# Implementation Plan: Status Page Baseline (as built)

**Branch**: `000-status-page-baseline` | **Date**: 2026-09-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/000-status-page-baseline/spec.md`

## Summary

Describes the architecture as delivered between 2026-09-02 and 2026-09-04 so that
`/speckit-converge` can compare the code with the baseline specification. Nothing here is
planned work; the tasks file lists what was built, all complete.

## Technical Context

**Language/Version**: Python 3.8+ standard library (collector); ES2020 JavaScript, CSS (page); CloudFormation YAML (infra); Bash (install, deploy)

**Primary Dependencies**: AWS CLI v2 on hosts; vendored uPlot 1.6.32; self-hosted Roboto; no build tooling

**Storage**: per-host SQLite (`/var/lib/reactome-status/points.sqlite`, 91 days of 5-minute rows); S3 bucket `status.reactome.org` (versioned, lifecycle rules)

**Testing**: local fake-log runs with `--state-dir`; headless Chrome renders against real and adversarial data; dry runs on production with a private state directory; six adversarial review rounds with reproductions

**Target Platform**: systemd Linux EC2 host with an instance role; CloudFront with ACM certificate at status.reactome.org

**Project Type**: monitoring agent + static page + IaC

**Performance Goals**: collector run < 2 CPU-s; page render < 3 s; adversarial log line < 1 ms

**Constraints**: constitution I–X; public repository; privileged steps run by the operator

**Scale/Scope**: one host, 6 services, 10 checks, 7 log groups, 7 charts

## Constitution Check

All ten principles were derived from this implementation; see the convergence phase in
tasks.md for the one documented gap (upload permission scoped to `data/*` rather than to the
host's own prefix, because the instance role is shared).

## Project Structure

### Source Code (repository root)

```text
collector/
├── collector.py                    # snapshot, linear log parser, SQLite, rollups, cp/sync upload
├── config/reactome.org.json        # per-host configuration
├── reactome-status-collector.service / .timer   # sandboxed oneshot at *:1/5
├── install.sh / uninstall.sh       # idempotent; ACL grant; version print
site/
├── index.html, app.js, style.css, theme.js, hosts.json, 404.json
├── assets/ (logos), vendor/uplot-1.6.32/, vendor/roboto/
infra/
├── status-site.yaml                # bucket, two origins (site/, uploads), OAC, cache and header policies, function, IAM
└── deploy.sh                       # cert, stack, site
docs/PLAN.md                        # original design notes
```

**Structure Decision**: single repository, three independently deployable parts (collector to hosts, site to S3, stack to CloudFormation).

## Key decisions (as built)

- Data flows one way: host → S3 → CloudFront → viewer. A stale `latest.json` is the outage signal.
- Uptime is computed on the page from series files, time-weighted, with missing expected samples counted as down and coverage ending at the series' generation time while the host is fresh.
- The access-log parser is a linear escape-aware scan; group matching uses the normalised path.
- One sample per 5-minute slot; history pruned by row count; atomic file writes; corruption quarantined.
- Uploads: `aws s3 cp --recursive` for live files (unconditional), `aws s3 sync` per day directory for the raw archive.
- CloudFront: page from `site/` via OriginPath; `data/*` and `raw/*` from a second origin with forced JSON content type, sandbox CSP and a 5-minute maximum TTL; path-only cache key; page CSP with no third-party origins.
- Collector user: own group; log access via ACL; systemd sandboxing (capabilities dropped, read-only system, private tmp, restricted address families and syscall architectures).

# Research: Multi-Host Monitoring

## Decisions

### One bucket, one page, per-host prefixes
- **Decision**: keep a single bucket and a single page; each host writes under `data/<host>/` and `raw/<host>/`.
- **Rationale**: the page already iterates a host list; a bucket per host would multiply CloudFront distributions and certificates for no isolation gain, since CloudFront already serves uploads as inert JSON.
- **Alternatives considered**: bucket per host (rejected: cost and operational overhead); one prefix with host as a field (rejected: no per-host IAM scoping possible).

### Per-host upload policy where the host has its own role
- **Decision**: for each host with its own instance role, attach a managed policy limited to that host's two prefixes. Hosts that share `EC2CloudwatchAgentRole` (hosts sharing the production role) keep the existing shared policy.
- **Rationale**: constitution IV. Splitting the shared role would mean changing the instance profile of three running production machines, which is a separate, riskier change.
- **Alternatives considered**: bucket policy `Deny` with a condition on the source instance (rejected: `aws:SourceInstanceARN` is not available for role-session uploads via the CLI in all paths and is brittle); one role per host created by this stack (deferred: requires instance profile swaps on live machines).

### Config-only host differences
- **Decision**: any difference between hosts is expressed in the host's JSON config: `systemd_units`, `http_probes`, `tcp_probes`, `service_probe`, `expected_restarts`, `access_log.path`, `access_log.groups`, `interval_seconds`, `disks`.
- **Rationale**: FR-005/FR-008; this is how the collector was designed and it has held for reactome.org.
- **Open question**: a host without Apache (or with nginx) needs `apache_status_url` omitted and `access_log` either omitted or given an nginx-compatible parser. The current parser assumes the Reactome combined format; an nginx host would need a `format` option. Decide after the surveys; out of scope unless a host requires it.

### Response-time absence is a state, not an error
- **Decision**: when no point in the window has a p95, the response-time chart shows "no timing data for this host" instead of "No data".
- **Rationale**: constitution IX; the curator log may use plain `combined`.

### Host summary row
- **Decision**: render a compact row of host chips (title, state dot, link) under the notice bar when more than one host is listed; hidden for a single host to keep the current look.
- **Rationale**: US1; matches the pattern of other status pages.

### Enlarged-view host selector (P3)
- **Decision**: add a host dropdown to the enlarged view only when more than one host is listed; the chart definition already keys on `hostName`, so switching re-runs `openModal` with a different key.
- **Rationale**: cheap once the summary exists; kept last because it is a convenience.

## Per-host unknowns (fill from read-only surveys; keep results out of the repo)

| Host | OS / Python / AWS CLI | Instance role | Services & ports | Log path & format | `%{ms}T`? | Notes |
|---|---|---|---|---|---|---|
| curator.reactome.org | ? | shares `EC2CloudwatchAgentRole` (known) | ? | ? | ? | |
| Plant Reactome (`plant-reactome-host`) | `<login>` | ? | ? | ? | ? | `useradd --system` and `setfacl` availability to confirm |
| CPWS | ? | ? | ? | ? | ? | in scope only if systemd + Apache-style log |

## Risks

- Amazon Linux differences: `python3` may be 3.9 (fine), AWS CLI may live in `/usr/bin` or `/usr/local/bin` (unit PATH covers both), `acl` package may need installing for `setfacl`.
- A host's log directory may not be group- or ACL-readable without changing ownership of an application directory; the install script must report this rather than guess.
- The page's colour assignment for unknown log groups is by hash; two new groups may land on the same palette slot. Acceptable for a first release; revisit if it happens.

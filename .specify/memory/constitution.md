# Reactome Status Constitution

The status page at https://status.reactome.org tells Reactome's users and staff whether the
production services are working, and shows how they have behaved over time. These principles
were established while building it and every change is checked against them.

## Core Principles

### I. Independent of what it monitors (NON-NEGOTIABLE)
The page is static files on S3 served by CloudFront. Nothing on a monitored host is in the
request path of a viewer. Each host pushes its own snapshot; the page never pulls from a host.
Consequence: a missing report is itself the outage signal, and the page MUST keep working,
and keep showing the last known state, when every monitored host is down.

### II. Missing data is downtime, never silence
Uptime figures and availability strips count every sample the collector was expected to send.
A sample that never arrived counts as *down*; only time before the first ever sample counts as
"no data". Coverage is measured to the moment the host was last known to be reporting, never
to a moment it could not have reported for. Percentages are floored, never rounded up to 100.

### III. Only aggregates leave a host
Snapshots contain counts, percentiles, states and latencies. No client IP address, user agent,
cookie, request URL, file path, internal hostname, port number or version of a monitored
service is ever uploaded. The deliberate exceptions are the host's public DNS name, the
collector's own version (so deploys can be verified) and the Reactome release number, which is
public information. Anything that reaches the bucket is public. Treat every field as if it will
be read by a stranger, because it will.

### IV. Least privilege on production
The collector runs as its own system user and group, sandboxed by systemd, with read access to
exactly the log directory it parses (granted by ACL, never by joining a group that owns other
files). It MUST NOT be in the `docker` group or any group that exposes credentials. It never
runs as root and refuses to. Its cloud permission is limited to putting and listing objects
under the upload prefixes (`data/` and `raw/`), never reading, deleting or touching the page.
Scoping to the host's own prefix is the goal; where hosts share an instance role this is not
yet achievable and is recorded as an accepted exception in the baseline tasks. A change that
widens any of this needs a written justification in the spec.

### V. Uploaded content is inert
The hosts' upload permission is shared and therefore untrusted. Everything under the upload
prefixes is served with a forced JSON content type and a sandboxing Content-Security-Policy,
from an origin path that cannot reach the page's own files. The page loads no third-party
resources, so it renders during incidents that affect other providers.

### VI. Never sample on the minute
Cron jobs, including the deliberate half-hourly Apache restart, fire at :00 and :30. The
collector samples at minute 1, 6, 11, …, waits out transient systemd states, and treats
configured expected restarts as routine rather than as incidents.

### VII. Parsing untrusted input is linear
The access log is attacker-controlled input. Parsing is a linear escape-aware scan with no
backtracking regex, a per-line failure is counted and never aborts a run, and a run that is
killed cannot cause the same log window to be counted twice (state is persisted before any
step that can hang).

### VIII. Fail loud, recover alone
A failure exits non-zero and appears in the journal. A corrupt local database is quarantined
and a fresh one started; a wrong clock leaves a gap, never a wipe; output files are written
atomically; the sample history is pruned by row count, never by wall-clock age (only the local
copies of already-uploaded raw snapshots and the S3 archive expire by age). The next run must
always be able to succeed without a human.

### IX. Honest numbers
Every figure states its window and resolution ("30-minute averages", "in 4 min 59 s").
Rolled-up values are labelled as means of percentiles, not as percentiles. Times are shown in
the viewer's local zone; the viewer's clock is corrected from the server. Bytes are shown in
binary units, matching the operating system's tools.

### X. Verified before deployed
A change to the page is rendered in headless Chrome against real and adversarial data before
it is uploaded. A change to the collector is run against a fake log locally and dry-run on
production with a private state directory before it is installed. The install command is
idempotent and prints the installed version.

## Constraints

- **Stack**: Python 3 standard library only on the hosts (plus the AWS CLI); plain HTML, CSS
  and JavaScript with the vendored uPlot library on the page; CloudFormation for AWS. No build
  step, no frameworks, no package installs on production.
- **Data layout**: `data/<host>/latest.json`, `data/<host>/series/{24h,7d,90d}.json`,
  `data/<host>/events.json`, `raw/<host>/YYYY/MM/DD/HHMM.json`; the page under `site/`.
  Adding a host is a config file, a line in `hosts.json` and an install, never new code paths.
- **Retention**: 91 days of 5-minute samples locally, 90 days of raw snapshots in S3, 30 days
  of noncurrent object versions.
- **Public repository**: no host survey results, credentials, account identifiers, instance
  names, login names, service versions, port inventories or hardware sizes; operational detail
  only where the code itself requires it (for example an IAM role name used as a parameter
  default). Security weaknesses and hardening gaps are never filed as public issues or written
  into public documents; they go to GitHub's private vulnerability reporting or an internal
  tracker, and become public only as the commit that fixes them.
- **Privileged steps**: anything needing root on a production host is a script the operator
  runs; the tooling stages it and prints the exact command.

## Development Workflow

- A specification (`/speckit-specify`) and plan (`/speckit-plan`) are required for any change
  that alters **what is uploaded**, **who may upload**, **how availability is computed**, or that
  adds a data source, a page section, a probe kind or an AWS resource.
- Everything else, including adding a host that needs only a config file and a host-list entry,
  goes straight to a commit with a test where one is practical.
- Periodic adversarial reviews with fresh eyes (security, operations, numerical correctness)
  are part of the process; findings are verified with a reproduction before being fixed.
- Every deploy of the page is followed by a live render check; every install of the collector
  is followed by confirming the served snapshot's version.

## Governance

This constitution supersedes habit and convenience. A change that conflicts with a principle
requires either changing the code or amending this document, with the amendment recorded in
the version line below and the reason in the commit message. Reviews check compliance with
the principles explicitly.

**Version**: 1.1.1 | **Ratified**: 2026-09-08 | **Last Amended**: 2026-09-08 (1.1.0: III exceptions, IV/VIII accuracy, workflow gate; 1.1.1: security gaps are not public issues)

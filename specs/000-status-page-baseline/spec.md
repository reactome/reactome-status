# Feature Specification: Status Page Baseline

**Feature Branch**: `000-status-page-baseline`

**Created**: 2026-09-08

**Status**: Implemented (describes the system as delivered on 2026-09-04; used as the reference for `/speckit-converge`)

**Input**: User description: "A public status page for Reactome production services that keeps working when production is down, showing service state, health checks, traffic, response times and host load over time, fed by a collector that runs on each production host every five minutes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See whether production is up right now (Priority: P1)

A Reactome user or staff member opens status.reactome.org and within a few seconds knows whether the
production services are working, and if not, which ones and since when.

**Why this priority**: This is the reason the page exists; everything else is context.

**Independent Test**: Load the page with a fresh snapshot and with a snapshot older than the alert threshold; the pill, per-service dots and banner reflect each state.

**Acceptance Scenarios**:

1. **Given** every service and health check in the latest snapshot is OK and the snapshot is fresh, **When** the page loads, **Then** the pill reads "All systems operational" and every service shows a green dot.
2. **Given** a snapshot older than two reporting intervals plus slack, **When** the page loads, **Then** a red banner says no report has been received since the snapshot time, the pill reads "Problems detected", and the last known details are still shown.
3. **Given** a snapshot in which one service is down, **When** the page loads, **Then** that service shows a red dot, the pill reads "Problems detected", and the other services are unaffected.
4. **Given** the viewer's network cannot reach the data but a previous load succeeded, **When** the page refreshes, **Then** it keeps the last good data and says the refresh failed, rather than declaring the host down.

---

### User Story 2 - Understand behaviour over time (Priority: P2)

A staff member investigating a report of slowness switches between 24-hour, 7-day and 90-day views to see traffic, response times, health-check latency, Apache workers, load and memory, and enlarges any chart to inspect it, optionally over a custom window.

**Why this priority**: Turns the page from a light into an instrument.

**Independent Test**: With a day of samples, each range renders seven charts whose x-axis spans exactly the selected window; enlarging a chart opens it with its own range control and a working custom window.

**Acceptance Scenarios**:

1. **Given** any amount of history, **When** a range is selected, **Then** every chart's x-axis spans exactly that window ending now, with data at the right edge and gaps where reports were missing.
2. **Given** an enlarged chart, **When** a custom window is entered, **Then** the chart uses the finest stored history covering the window and states its resolution.
3. **Given** a chart with several series, **When** a legend chip is clicked or double-clicked, **Then** that series is hidden or shown alone and the axis rescales.

---

### User Story 3 - Trust the uptime figures (Priority: P2)

A manager reads the availability percentage and strip for each service and health check over the selected range and can rely on them, including for periods when the host was not reporting.

**Why this priority**: A status page that shows 100% through an outage is worse than none.

**Independent Test**: Remove a contiguous block of samples from a series and confirm the percentage drops by the missing fraction and the strip shows the gap.

**Acceptance Scenarios**:

1. **Given** a service down for 15 minutes in the last 24 hours, **When** any range is viewed, **Then** its percentage is 100% minus the exact fraction, and the strip marks the interval.
2. **Given** the host was silent for 3 hours, **When** the 24-hour view is shown, **Then** every service's percentage reflects those 3 hours as down and the strip is red for them.
3. **Given** the first ever sample is two days old, **When** the 90-day view is shown, **Then** time before it counts as no data, not as down.

---

### User Story 4 - Operate the collector safely (Priority: P3)

An operator installs, upgrades, tests and removes the collector on a production host with a single idempotent command each, without the collector ever gaining access it does not need.

**Independent Test**: Run the install script twice, a private-state-dir test run, and the uninstall script; the host is left exactly as before.

**Acceptance Scenarios**:

1. **Given** a fresh host, **When** the install script runs, **Then** a dedicated user and group exist, the log directory carries an ACL for that user only, the timer is enabled at minutes 1, 6, 11, …, one collection has run, and the installed version is printed.
2. **Given** an operator runs the collector as root or against the live state directory with uploads disabled, **When** it starts, **Then** it refuses with the correct command to use instead.

### Edge Cases

- A crafted HTTP request line of maximal length is parsed in constant time per byte and cannot spoof the status or size fields.
- A corrupt local database is quarantined and a fresh one started; a stepped clock leaves a gap in the charts rather than deleting history.
- An uploaded object of any content type under the data prefixes is served as JSON with a sandboxing policy and cannot execute.
- Browser storage that throws, a stale or malformed stored range, and a malformed shared link all fall back to a working default view.
- Two runs in one five-minute slot leave one sample for the slot.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The collector MUST record systemd unit state and start time, HTTP and TCP health checks with latency, Apache worker counts, access-log aggregates per URL group (hits, status classes, p50/p95/max response time), and host load, memory and disk, every five minutes.
- **FR-002**: The collector MUST parse only the bytes appended to the access log since its previous run, survive rotation without losing the tail of the previous file, and never re-count a window after being killed.
- **FR-003**: The collector MUST publish a current snapshot, 24-hour (5-minute), 7-day (30-minute) and 90-day (6-hour) series, and an events list, and archive every snapshot for 90 days.
- **FR-004**: The collector MUST detect service restarts and record the time until the associated health check first passed, and MUST treat configured expected restarts as routine.
- **FR-005**: Published data MUST contain no client IP addresses, user agents, URLs, file paths, hostnames, ports or software versions.
- **FR-006**: The page MUST treat a snapshot older than one interval plus slack as a warning and older than two intervals plus slack as the host being down.
- **FR-007**: The page MUST compute availability with missing expected samples counted as down, time-weighted, clipped to the selected range, floored to two decimals and never rounded up to 100%.
- **FR-008**: The page MUST render every chart's x-axis over exactly the selected window regardless of how much data exists.
- **FR-009**: The page MUST isolate a rendering failure to the affected host and never show "All systems operational" when nothing has loaded.
- **FR-010**: The page MUST keep the last good data and say so when the viewer's own fetch fails.
- **FR-011**: The page MUST let a user enlarge any chart, change its range independently, choose a custom window, download the shown data as CSV, and copy a link that reproduces the view.
- **FR-012**: The page MUST follow the system colour scheme by default and allow a light or dark override, remembered per browser.
- **FR-013**: The infrastructure MUST serve host uploads as inert JSON from an origin path separate from the page, key the CDN cache on the path only, cap the cache lifetime of live snapshots at five minutes, and keep object versions for 30 days.
- **FR-014**: The install script MUST be idempotent, pause the timer while replacing files, grant log access by ACL, keep a backup of a locally edited config, and print the installed version.

### Key Entities

- **Host**: a monitored machine; identified by its DNS name; has a config file, a data prefix and a display title.
- **Snapshot**: the result of one collector run on one host: host metrics, services, probes, Apache status, access-log aggregates, recent events.
- **Point**: a compact per-interval record used for series; rolled-up points carry sample counts and first/last sample times.
- **Event**: a restart, outage or recovery of a service with timestamps.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the production host unreachable, the page loads and shows the outage within 12 minutes of the last report.
- **SC-002**: Availability figures match ground truth within 0.1 percentage point for synthetic outages and silences in every range.
- **SC-003**: One collector run uses under 2 CPU-seconds and under 100 MB, and parses a 16 KB adversarial log line in under 1 ms.
- **SC-004**: The page renders fully with browser storage blocked, with a corrupt stored range, with a malformed shared link, and with a malformed field in any snapshot.
- **SC-005**: Every log line in the production access log parses (unparsed count is zero over a day).

## Assumptions

- Monitored hosts run systemd, Python 3.8 or newer and the AWS CLI, and reach S3 through an instance role.
- Apache logs with the "combined_format" that ends in `%I %{ms}T`; a format without response time degrades to charts without timing data rather than failing.
- Viewers use a current browser; the page is public and indexed by nobody while in alpha.

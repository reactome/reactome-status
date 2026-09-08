# Feature Specification: Multi-Host Monitoring

**Feature Branch**: `001-multi-host-monitoring`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Add the curator server (curator.reactome.org), Plant Reactome and possibly CPWS to the status page alongside reactome.org, so one page shows the state of every production system Reactome runs."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See every production system on one page (Priority: P1)

A staff member opens the status page and sees each monitored system as its own section, with a summary row at the top listing every host and its state so the overall picture is clear before scrolling.

**Why this priority**: The page is only a status page for Reactome if it covers Reactome, not one server.

**Independent Test**: Publish snapshots for two hosts under their own prefixes and list both in the host list; the page shows two sections, a two-entry summary row, and the pill reflects the worse of the two.

**Acceptance Scenarios**:

1. **Given** two or more hosts in the host list, **When** the page loads, **Then** a summary row shows each host's title and state, each entry links to that host's section, and the pill reflects the worst host.
2. **Given** one host is not reporting and another is healthy, **When** the page loads, **Then** the silent host's section carries the red banner, the healthy host is unaffected, and the pill reads "Problems detected".
3. **Given** a host is listed but has never reported, **When** the page loads, **Then** its section says so and the other hosts render normally.

---

### User Story 2 - Add a host without new code (Priority: P1)

An operator brings a new host under monitoring by writing one config file describing its services, checks and log, installing the collector with the standard command, and adding one line to the host list.

**Why this priority**: Three hosts are planned; the design must make the fourth cheap.

**Independent Test**: Follow the documented steps on a host with a different service set and log format; the host appears on the page within ten minutes, needing only a config file, a host-list entry and an install.

**Acceptance Scenarios**:

1. **Given** a host whose Apache log lacks response times, **When** it is added, **Then** its request and status charts render and its response-time chart says "no timing data" rather than failing or showing zeros.
2. **Given** a host with services the page has never seen (for example a curator tool or a different database), **When** it is added, **Then** those services appear with stable colours in its own section.
3. **Given** a host running a different Linux distribution, **When** the install script runs, **Then** it either completes or stops with a clear message naming the missing prerequisite.

---

### User Story 3 - A compromised host cannot fake another (Priority: P2)

Each host can write only under its own data prefix, so a problem on one machine cannot alter what the page says about another.

**Why this priority**: Constitution principle IV; the current shared role is an accepted exception that must not grow.

**Independent Test**: From host A, attempt to upload to host B's prefix; the upload is denied.

**Acceptance Scenarios**:

1. **Given** a host with its own cloud role, **When** it uploads under its own prefix, **Then** the upload succeeds; **When** it uploads under another host's prefix, **Then** it is denied.
2. **Given** hosts that necessarily share a role, **When** the feature is delivered, **Then** the sharing is recorded in the plan with the mitigation that served content is inert.

---

### User Story 4 - Compare hosts (Priority: P3)

A staff member enlarges a chart and can switch it to show the same measure for a different host without leaving the enlarged view.

**Why this priority**: Useful once two hosts exist, but not needed for the first release.

**Independent Test**: With two hosts, the enlarged chart offers a host selector and switching updates the data and the shared link.

**Acceptance Scenarios**:

1. **Given** an enlarged chart and two hosts, **When** the other host is selected, **Then** the chart shows that host's data over the same window and the copied link reproduces the choice.

### Edge Cases

- Two hosts with the same service name: keys are per host and colours are per host; nothing is merged.
- A host with a different reporting interval: staleness thresholds, expected-sample counts and the "checked every N min" wording in the events table follow that host's interval.
- A host whose collector version lags: the page tolerates missing fields introduced later.
- The host list itself fails to load: the page says so and does not claim all systems are operational (already delivered in the baseline; no task).
- A host removed from the list: its data stops being shown but its history stays in the bucket until the lifecycle rule expires it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The host list MUST support any number of hosts, each with a name, display title, data prefix and optional order, and MUST be the only place a host is registered on the page.
- **FR-002**: The page MUST render a host summary row whenever more than one host is listed, with each entry showing the host's title and state and linking to its section.
- **FR-003**: The page MUST evaluate each host's state independently and derive the overall pill from the worst host.
- **FR-004**: The page MUST handle a host whose access-log format provides no response times by labelling the response-time chart "no timing data".
- **FR-005**: The collector MUST run unchanged on every host; every per-host difference MUST be expressed in the host's config file (services, checks, log path and groups, expected restarts, interval).
- **FR-006**: The install script MUST verify its prerequisites (systemd, Python 3.8+, AWS CLI, an instance role with upload rights) and stop with a clear message if one is missing.
- **FR-007**: Each host MUST be able to write only under `data/<host>/` and `raw/<host>/`, except where hosts already share an instance role; that exception MUST be documented in the plan.
- **FR-008**: Once this feature is delivered, adding a host MUST need only a config file, a host-list entry, an install, and (for a host with its own role) naming that role in a stack parameter; no collector, page or template code changes.
- **FR-009**: The documentation MUST contain a step-by-step "add a host" procedure that a colleague can follow without prior knowledge of the project.
- **FR-010**: The enlarged chart view SHOULD offer a host selector when more than one host is listed (P3).

### Key Entities

- **Host entry**: `name`, `title`, `prefix`, optional `order`; lives in the host list.
- **Host config**: per-host collector configuration; identifies the host, its S3 prefixes, services, checks and log.
- **Upload role**: the cloud identity a host uploads with; ideally one per host.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: curator.reactome.org and Plant Reactome appear on the page with complete sections within one working session each, following only the documented procedure.
- **SC-002**: The page with four hosts loads and renders in under 3 seconds on a 10 Mbit/s, 50 ms connection (measured headless with network throttling).
- **SC-003**: An upload from one host to another host's prefix is denied for every host that has its own role.
- **SC-004**: The third and later hosts are added with a config file, a host-list entry, an install and at most a stack parameter; no code changes.

## Assumptions

- The Plant Reactome host has its own instance role; the curator server shares the production role (the documented exception).
- CPWS is included only if it runs on a host Reactome administers with systemd and an Apache-style log; otherwise it is out of scope for this feature.
- Each new host is surveyed read-only before its config is written; the survey stays out of the public repository.
- Alerting remains out of scope.

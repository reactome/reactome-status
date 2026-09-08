# Data Model: Multi-Host Monitoring

## Host entry (`site/hosts.json`)

```json
{
  "hosts": [
    { "name": "reactome.org",         "title": "reactome.org — production web server", "prefix": "data/reactome.org",         "order": 1 },
    { "name": "curator.reactome.org", "title": "curator.reactome.org — curation server", "prefix": "data/curator.reactome.org", "order": 2 }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | unique; the host's DNS name; used as the section id and in shared links |
| `title` | string | shown in the section header and summary row |
| `prefix` | string | `data/<name>`; the page fetches `<prefix>/latest.json`, `<prefix>/series/<range>.json`, `<prefix>/events.json` |
| `order` | integer, optional | sort key for sections and the summary row; ties broken by list order |

Entries missing `name` or `prefix` are ignored by the page (already implemented).

## Host config (`collector/config/<name>.json`)

Existing schema; fields relevant to multi-host:

| Field | Purpose |
|---|---|
| `host` | must equal the host entry's `name` |
| `s3_bucket`, `s3_prefix`, `s3_raw_prefix` | `status.reactome.org`, `data/<host>`, `raw/<host>` |
| `interval_seconds` | reporting interval; the page's staleness thresholds follow it |
| `systemd_units`, `http_probes`, `tcp_probes`, `service_probe`, `expected_restarts` | what to check |
| `apache_status_url` | omit on hosts without mod_status |
| `access_log.path`, `access_log.groups` | omit `access_log` on hosts without an Apache log |
| `disks` | mount points to report |

## Upload role

| Host | Role | Policy |
|---|---|---|
| hosts sharing the production role (reactome.org, curator.reactome.org, …) | shared production role | existing `status.reactome.org-collector-upload` (`data/*`, `raw/*`) — documented exception |
| Plant Reactome host | its own instance role | new per-host policy: `data/<host>/*`, `raw/<host>/*`, scoped `ListBucket` |
| CPWS (if in scope) | its own instance role | per-host policy |

## Page state additions

- `state.hosts` sorted by `order`.
- Each host section: `id="host-<name>"`, `data-status` as today.
- Summary row: one chip per host: title, dot class from `data-status`, `href="#host-<name>"`.
- Response-time chart: `noTiming = !view.pts.some(p => Object.values(p.log || {}).some(r => Array.isArray(r) && r[6] != null))` → empty-state text "no timing data for this host".

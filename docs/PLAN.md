# Reactome status page — plan

Goal: a static page at https://status.reactome.org (S3 + CloudFront) showing health,
uptime and traffic statistics for production services, fed by a collector that runs
on each production host and pushes a snapshot to S3 every 5 minutes. The page keeps
working when a host is down; a stale snapshot *is* the down signal.

## Survey of the production host

The initial survey of reactome-prod (services, ports, log locations, tooling) informed the
design below but is kept out of this public repository; see the internal notes.

## Architecture

```
 reactome-prod ─┐   every 5 min            ┌─ S3 bucket (private) ──────┐   CloudFront + ACM   status.reactome.org
 curator (later)─┼─ collector.py ─ s3 sync ─▶ data/<host>/latest.json     ├──────────────────▶  static HTML/JS
 other hosts    ─┘                          │  data/<host>/series/{24h,7d,90d}.json, events.json
                                            │  raw/<host>/YYYY/MM/DD/HHMM.json (90-day lifecycle)
                                            │  index.html, app.js, vendor/ │  (OAC, no public S3)
                                            └────────────────────────────┘
```

### 1. Collector (runs on each host)
Single Python 3 script, stdlib only, systemd timer every 5 min, dedicated user in
group `reactome` (read access to the log). Per host a small YAML/JSON config lists
services, probes and log path so curator.reactome.org is just another config.

Collected each run:
- **Service state**: `systemctl is-active` for apache2, tomcat, neo4j, solr, mysql, docker; `docker ps` for the chatbot containers.
- **HTTP probes** with latency: ContentService/AnalysisService version endpoints, PathwayBrowser, neo4j :7474, solr :8983 (401 = alive; real ping if creds provided), chatbot :8000/:8001.
- **Apache mod_status**: requests/sec, busy vs idle workers, avg request duration.
- **Access log window** (last 5 min, read from a saved byte offset so the 530 MB file is never re-read; rotation-safe): hits, 2xx/3xx/4xx/5xx counts, p50/p95 response time, bytes — bucketed by service prefix (/ContentService, /AnalysisService, /PathwayBrowser, /content, /chat, other). Aggregates only; no IPs or user agents ever leave the host.
- **Host**: load, memory, swap, disk, uptime, boot time.

Output: one JSON snapshot. Uploaded as `latest.json`, an immutable timestamped copy under
`raw/`, rolling `series/24h.json`, `series/7d.json`, `series/90d.json` and `events.json`, so
the browser fetches a handful of files, not hundreds. See README.md for the authoritative layout.

### 2. Storage / delivery
- Private S3 bucket, CloudFront with Origin Access Control, ACM certificate in us-east-1.
- Cloudflare: DNS-only (grey cloud) CNAME `status` → CloudFront domain, plus the ACM validation CNAME.
- S3 lifecycle: expire 5-min snapshots after 90 days; keep rollups.
- IAM: a policy on the hosts' instance role allowing `s3:PutObject` under `data/*` and `raw/*` (shared by all hosts using that role; a dedicated per-host role would tighten this). CloudFront serves those prefixes as inert JSON regardless of what was uploaded.
- Infra defined as one CloudFormation template (or Terraform if you already use it) checked into this repo.

### 3. Frontend (static)
- Plain HTML + JS, no build step; uPlot (tiny) or Chart.js for graphs.
- Header: overall status. Per-host card: services up/down, last-seen time, **stale banner if latest.json is older than 10 min** ("no report from reactome.org since HH:MM").
- Graphs over time (1 h / 24 h / 7 d / 90 d): hits per service, status-code mix, p95 latency, apache busy workers, load, memory, disk.
- Optional `announcements.json` in the bucket for planned-maintenance notices.

### 4. Alerting (optional, later)
Small Lambda or CloudWatch alarm on "latest.json older than 15 min" → email/Slack.

## Rollout
1. Repo skeleton: `collector/`, `site/`, `infra/`, README.
2. Collector written and tested on reactome-prod writing to a local dir (no AWS changes needed yet).
3. Infra: bucket, CloudFront, cert, IAM policy, DNS record.
4. Frontend against real snapshots; publish.
5. Systemd timer installed on reactome-prod (needs a sudo session).
6. Add curator.reactome.org with its own config.

## Open questions
- Who applies the AWS changes (IAM policy, bucket, CloudFront, ACM)? No AWS credentials are configured on this workstation.
- Public page, or restricted? (Affects nothing in the data model; aggregates only either way.)
- Solr credentials for a real ping, or is "port answers" good enough?
- Installing the systemd unit and a service user needs sudo on reactome-prod (password required).
- Preferred IaC: CloudFormation vs Terraform.

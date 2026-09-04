# Reactome status page

Static status page for Reactome production services, published at
**https://status.reactome.org**. Each production host runs a small collector every
5 minutes that uploads a JSON snapshot to S3; CloudFront serves the bucket. Because
the page is static and the data lives in S3, it stays up when a production server
does not, and a missing report *is* the outage signal.

> **Alpha.** Not yet an official Reactome service; numbers may be incomplete or wrong.

## Layout

| Path | What |
|---|---|
| `collector/collector.py` | Stdlib-only Python 3 collector. systemd units, HTTP/TCP health checks, Apache `mod_status`, access-log aggregates, host load/memory/disk, restart detection. Uploads with the AWS CLI. (Docker container checks exist in the code but are unused: the collector deliberately has no Docker socket access; containers are checked over HTTP/TCP instead.) |
| `collector/config/<host>.json` | Per-host configuration (what to check, log path, S3 prefix). |
| `collector/*.service`, `*.timer`, `install.sh` | systemd units and the sudo install script. |
| `site/` | The static page: `index.html`, `app.js`, `style.css`, vendored [uPlot](https://github.com/leeoniya/uPlot), `hosts.json` (list of hosts shown). |
| `infra/status-site.yaml` | CloudFormation: private S3 bucket, CloudFront (OAC, HTTPS), lifecycle rule, IAM upload policy. |
| `infra/deploy.sh` | Certificate request, stack deploy, site upload. |
| `docs/PLAN.md` | Original design notes and survey of the production host. |

## Data in the bucket

```
data/<host>/latest.json        current snapshot            (Cache-Control 60 s)
data/<host>/series/24h.json    5-min points, last 24 h
data/<host>/series/7d.json     30-min points, last 7 d
data/<host>/series/90d.json    6-h points, last 90 d
data/<host>/events.json        restarts / outages, last 90 d
raw/<host>/YYYY/MM/DD/HHMM.json  every snapshot, expired after 90 d by S3 lifecycle
site/                          the page itself (served via a CloudFront origin path; hosts cannot write here)
```

Only aggregates leave a host: request counts, status-class counts and latency
percentiles per URL group. No client IPs, user agents or full URLs are uploaded.
The page is public, so nothing in a snapshot should be sensitive.

## Using the page

- The 24 h / 7 d / 90 d buttons set the range for the whole page; the choice is remembered per browser.
- Click the ⤢ icon on any chart (or double-click the plot) to enlarge it. The enlarged view has its own
  range control plus a custom From/To window; it uses the finest history that covers the window and
  says which resolution it is showing. "Download CSV" exports the shown window; "Copy link" copies a URL
  that reopens exactly that chart and window (the address bar always reflects the current view).
- The ◐ button cycles the colour theme: follow the system, light, dark.

## Deploying the site (once)

```bash
infra/deploy.sh cert     # request ACM cert; add the printed CNAME in Cloudflare (DNS only)
infra/deploy.sh stack    # once the cert is ISSUED: bucket + CloudFront + IAM policy
infra/deploy.sh outputs  # DistributionDomainName -> Cloudflare CNAME for status.reactome.org (DNS only)
infra/deploy.sh site     # upload site/ (re-run after any page change)
```

The stack attaches an upload policy to the production hosts' existing instance role
(`EC2CloudwatchAgentRole`), so the collector needs no access keys.

## Installing the collector on a host

```bash
git clone https://github.com/reactome/reactome-status.git
sudo reactome-status/collector/install.sh reactome-status/collector/config/reactome.org.json
```

This creates a `reactome-status` system user with its own group, grants it read access to the
Apache log directory with a narrow ACL (not group membership, which would also expose other
group-readable files such as CMS credentials; deliberately not `docker` either, which would be
root-equivalent), installs the script under `/opt/reactome-status`, the config under
`/etc/reactome-status`, state under `/var/lib/reactome-status`, and enables a timer that runs at
minutes 1, 6, 11, … past the hour (deliberately off the :00/:30 marks that cron jobs use). Check with:

```bash
systemctl list-timers reactome-status-collector.timer
journalctl -u reactome-status-collector.service -n 20
```

Stop it with `sudo systemctl disable --now reactome-status-collector.timer`, or remove it
entirely with `sudo collector/uninstall.sh`. The unit is capped at half a CPU and 512 MB
and runs with a read-only view of the filesystem.

To try it without uploading (any user in the `reactome` group), point it at a private state
directory so it does not touch the installed collector's history:

```bash
python3 collector/collector.py -c collector/config/reactome.org.json --state-dir /tmp/status-test --no-upload --print
```

## Adding another host (e.g. curator.reactome.org)

1. Copy `collector/config/reactome.org.json` to `collector/config/curator.reactome.org.json`,
   set `host`, `s3_prefix` (`data/curator.reactome.org`), and adjust units, probes and log path.
2. Add the host to `site/hosts.json` and run `infra/deploy.sh site`.
3. Make sure the host's instance role has the upload policy (stack output `CollectorUploadPolicyArn`).
4. Run `install.sh` on the host.

## Local development of the page

```bash
# pull real snapshots from a host into site/data/ (git-ignored) then serve
cd site && python3 -m http.server 8765
```

## Restart tracking

A restart is detected when a service's start time (systemd `ExecMainStartTimestamp`
or Docker `StartedAt`) changes between runs. The collector then records when the
service's health check first passes again, giving a time-to-healthy with 5-minute
resolution. Events appear in `events.json` and in the "Recent service events" table.

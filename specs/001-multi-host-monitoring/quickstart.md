# Quickstart: Adding a Host

This is the operator procedure. It becomes the "Adding a host" section of the README.

## 1. Survey the host (read-only, results stay out of the repository)

On the host, note: OS and version, `python3 --version`, `aws --version`, the instance role
(`aws sts get-caller-identity`), the systemd units that matter, the ports that answer on
localhost, the Apache access log path and its `LogFormat`, whether `setfacl` exists, and any
scheduled restarts (so they can go in `expected_restarts`).

## 2. Write the host config

Copy `collector/config/reactome.org.json` to `collector/config/<host>.json` and set:

- `host`, `s3_prefix` (`data/<host>`) and, if you want, `s3_raw_prefix` (`raw/<host>`).
- `systemd_units`, `http_probes`, `tcp_probes`, `service_probe`, `expected_restarts`.
- `access_log.path` and `access_log.groups`, or remove `access_log` if there is no Apache log.
- Remove `apache_status_url` if mod_status is not enabled.

Commit and push; pull the repository on the host.

## 3. Grant upload rights

- If the host uses `EC2CloudwatchAgentRole`, nothing to do: the shared policy already applies.
- Otherwise add `<host>=<role name>` to the `HOST_ROLES` value used by `infra/deploy.sh stack`
  (it becomes the stack's `HostRoles` parameter); the stack attaches a policy limited to
  `data/<host>/*` and `raw/<host>/*`.

## 4. Dry-run, then install

```bash
python3 collector/collector.py -c collector/config/<host>.json --state-dir /tmp/status-test --no-upload --print
sudo collector/install.sh collector/config/<host>.json
```

Run the dry run twice a minute apart: the first run only records the log position, the second
must show `ok` for the checks you expect and zero unparsed log lines. The install prints the
ACL grant and the installed version; the first upload happens immediately.

## 5. Register the host on the page

Add an entry to `site/hosts.json` with `name`, `title`, `prefix` and `order`, then run
`infra/deploy.sh site`. The host appears within one refresh; its history fills in from there.

## 6. Verify

- `https://status.reactome.org/data/<host>/latest.json` returns the new snapshot.
- The page shows the host's section and the summary row lists it.
- The three series files exist after the first run (the coarse ones are then rebuilt every 30 minutes); after a day, the uptime figures are meaningful.

## Removing a host

Run `sudo collector/uninstall.sh` on the host, remove its entry from `site/hosts.json`, deploy
the site, and detach its policy if it had one. Its history in the bucket expires with the
lifecycle rules.

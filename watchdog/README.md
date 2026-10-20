# Watchdog

Restarts a production service that is **running but not answering**. systemd already
restarts a service whose process exits; it cannot see a JVM that is alive but stuck
(for example in garbage collection after the heap fills). The collector only observes;
the watchdog is the one part of this repository that acts on a host, so it is a separate
program with its own unit and its own rules (constitution, principle XI).

It sends no alerts and uploads nothing. Every action is in the journal and in
`/var/lib/reactome-watchdog/events.jsonl`.

## What it does

A systemd timer runs `watchdog.py` every minute (at second 30, away from the :00 cron
jobs). For each service in the config it runs the probes, which go straight to the
service rather than through Apache. After `fail_threshold` failed runs in a row it:

1. saves evidence to `/var/lib/reactome-watchdog/evidence/<time>-<service>/` (root only):
   `top -H`, `jstat -gcutil`, and the last 10 minutes of the access log by client and
   path; it also sends SIGQUIT so the JVM prints a thread dump to its own log;
2. runs `systemctl restart`; if that fails, SIGKILLs the unit and starts it.

It does **nothing** when:

| Condition | Why |
|---|---|
| the unit is not `active` | stopped on purpose, or already starting or stopping |
| the unit started less than `startup_grace_s` ago | Tomcat takes minutes to deploy its webapps |
| a service in `requires` is failing | restarting Tomcat does not fix its database |
| `max_restarts` already happened within `restart_window_s` | no restart loops; records `gave_up` |
| the `pause_file` exists | maintenance, data releases, deploys |

A service with `"restart": false` is probed only, as a dependency of others.

## Configuration

`config/example.json` shows every option. A host's real config
(`config/<host>.json`) is **git-ignored**: it names internal ports and paths, and the
repository is public. Keep it on the host (it is installed to
`/etc/reactome-watchdog/config.json`, mode 600) and in your local checkout.

## Install / update

```bash
sudo watchdog/install.sh watchdog/config/<host>.json   # first install; does a dry run first
sudo watchdog/install.sh                               # later: update the code, keep the installed config
journalctl -u reactome-watchdog -n 50                  # what it saw and did
cat /var/lib/reactome-watchdog/events.jsonl            # auto_restart / gave_up / recovered
sudo touch /etc/reactome-watchdog/PAUSE                # pause; remove the file to resume
sudo watchdog/uninstall.sh
```

`install.sh` also shortens Tomcat's stop timeout to 30 s (a stuck JVM ignores SIGTERM)
and creates `/var/tmp/tomcat-heapdumps`; the watchdog keeps only the newest dump there.

Without root or side effects: `python3 watchdog/watchdog.py -c <config> --dry-run`.
Before committing a change: `python3 watchdog/selftest.py`.

## JVM settings (`jvm-tuning.sh`)

Separate from the watchdog. `sudo watchdog/jvm-tuning.sh` shows the change,
`sudo watchdog/jvm-tuning.sh apply` backs up and applies it; it restarts nothing.

- Tomcat: 14 GB heap, `-XX:+ExitOnOutOfMemoryError` (so `Restart=on-failure` restarts it
  instead of it hanging), one heap dump on OutOfMemoryError, rotating GC log.
- Solr: 2 GB heap.

## Later

- Alerts: read `events.jsonl` and notify on `auto_restart` and `gave_up`.
- Show auto-restarts on the status page. That adds a data source to the collector, so it
  needs a spec first.

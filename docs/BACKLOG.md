# Backlog

Ideas and deferred recommendations, roughly in the order they were judged worth doing.
Anything here that alters what is uploaded, who may upload, or how availability is computed
needs a spec first (see the constitution's Development Workflow); the rest can go straight in.

## Next feature (specified)

- **Multi-host monitoring**: curator.reactome.org, Plant Reactome, possibly CPWS.
  `specs/001-multi-host-monitoring/` — start with the read-only surveys (T001–T003).

## Standard status-page features not yet present

1. **Incident and maintenance posts** with a timeline (investigating → identified → monitoring →
   resolved) and an RSS feed. A hand-edited `incidents.json` in the bucket is enough to start.
   The biggest gap versus a conventional status page: the data shows *that* something broke, a post
   says *what* and *when it will be fixed*.
2. **User-facing capability summary** at the top (Website, Pathway Browser, Analysis, Content
   Service API, Chatbot), each mapped to the checks behind it.
3. **Status history calendar**: 90 days coloured by worst state per day, incidents listed under each.
4. **Response-time target lines** on the latency charts so a reader knows what "good" is.

## Coverage

5. **External checks** from outside the network (a scheduled Lambda through Cloudflare writing into
   the same bucket): catches DNS, certificate and CDN problems the host cannot see and measures
   what users experience.
6. **Certificate expiry** for reactome.org with a warning under 14 days.
7. **Deeper service checks**: a real Analysis Service call, a Content Service query, an
   authenticated Solr ping, a Neo4j Cypher ping.
8. **Release and data version** shown prominently with its date.

## Operations and security (deferred by decision)

9. **Alerting** when a host stops reporting or the collector fails. Deferred; still the largest
   operational gap. Options: an `OnFailure=` unit publishing a CloudWatch metric, or a scheduled
   check of `latest.json` age with an alarm.
10. **Per-host IAM roles** instead of the shared production role, so each host can write only its
    own prefix (recorded as an accepted exception in `specs/000-status-page-baseline/tasks.md` T014).
11. **Enforce IMDSv2** on the EC2 instances that carry the upload role.
12. **CloudFront access logging and a budget alarm** for the public distribution.
13. **Announcement banner** driven by a file, replacing the hard-coded alpha notice when the page
    leaves alpha (remove the `noindex` at the same time).

## Smaller

14. Retain 5-minute detail beyond a day (per-day series files) so custom windows in the past keep
    full resolution.
15. Mark points with short windows (< half an interval) in the request-rate charts.
16. Store a latency histogram per point so 7-day and 90-day views can show true percentiles rather
    than means of 5-minute p95 values.

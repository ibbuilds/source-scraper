# Local bulk filter measurement

Run on 2026-11-02, Windows, Node v24.15.0, AMD Ryzen 7 3700X.
Synthetic paginated source, 500 observations per transaction, one distinct
external link per observation, no network or model calls. The full real engine
ingests observations and retains revisions, entities, mentions and assessments.
Each query scans the complete database three times, without accumulating the
result set in memory. Exact expected counts and URL presence are verified.

| Workload | Records | Three full-scan samples (ms) | Median (ms) |
| --- | ---: | --- | ---: |
| Topic filter before the supporting-observation index | 10,000 | 7442.15, 7452.49, 7448.96 | 7448.96 |
| Topic filter with the index | 10,000 | 376.15, 323.51, 299.75 | 323.51 |
| Topic filter with the index | 100,000 | 3276.57, 3155.94, 2965.35 | 3155.94 |
| Topic + last 30 days + likes/reposts minima, with the index | 100,000 | 3238.71, 3069.19, 3285.99 | 3238.71 |

The 100,000-record run ingested in 18,037 ms, retained all 100,000 links, and
returned the expected 14,400 matches for the combined profile. Its final RSS was
287 MiB and SQLite size 342 MiB. RSS is the sampled process value, not a measured
peak. Unfiltered link-only scans took 1227.46, 1513.70 and 2203.15 ms.
The small ingestion comparison was 2347 ms before and 2411 ms after, with final
database size increasing from 33 to 34 MiB: the extra index has a storage/write
cost. Samples reflect local scheduling and cache variance.

The initial 100,000-record baseline was stopped during source-level filtering
after consuming over five CPU minutes; no completed time is claimed for it.
`EXPLAIN QUERY PLAN` showed the old query choosing the mentions primary key by
project to satisfy ordering, repeating large scans for each resource. The added
`(project_id, entity_key, active, connection_id, item_id)` index makes both the
lookup and its ordering specific to the entity. A regression test explains the
actual production SQL and checks that plan.

Reproduce the current implementation:

```sh
node --experimental-strip-types scripts/bench-filters.mjs 100000 --thresholds
```

The script creates an isolated temporary library, verifies every count, prints
machine/runtime/batch/memory details and removes its own temporary directory.
These results establish local batch behavior for this data shape; they do not
establish million-record performance, independent-source concurrency, public
metadata fetching speed or X network throughput. For You remains a bounded feed
sample and stops on authentication/rate-limit failures.

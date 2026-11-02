# Pipeline performance review — 2026-11-02

Windows, Node v24.15.0, AMD Ryzen 7 3700X. Baseline engine revision
`228cc342d055a76e947aca856835d8801d446235` (merged in `6ce6599`), with its
unchanged immutable CLI, compared with the performance branch. Workloads are
isolated, synthetic and reproducible; no personal vault, credentials or X traffic.

## What changed

- All ordinary entity exports now use one streaming scan and a consistent read
  transaction. Unfiltered exports no longer repeatedly sort/skip each 500-row page.
- Provenance exports reuse the entity already read from that snapshot, avoiding
  another entity lookup for every result. Identity is checked before reuse.
- Optional public metadata enrichment shares four active resource fetches and a
  20-distinct-URL budget per run. Duplicate URLs share pending results. Reservation
  and returned order remain deterministic. A GitHub API-to-HTML fallback may make
  more than one HTTP request for a resource; the URL budget is not a raw HTTP quota.
- Metadata has one eight-second deadline across DNS, redirects and GitHub fallback.
  Cancellation reaches DNS waits and HTTP requests; late DNS cannot start HTTP.
  Generic public fetches without a supplied signal retain their previous timeout
  behavior. A failed page waits for sibling work to settle before releasing its
  caller, and never commits an incomplete checkpoint.

Custom processor/evaluator order, source collection paging, existing admission
rules, network permissions, the X request window and vault-note behavior stay intact.
This introduces no additional source, paid service or model call.

## Whole-pipeline workload: 20,000 posts / 20,000 links

Each source page has 500 observations. The benchmark exercises first ingest,
unchanged replay, a changed observation, offline reassessment, queries, evidence
inspection, CLI startup, JSON/NDJSON and provenance exports. Every exported key,
count and evidence presence is checked, along with retained revision counts.
Read/export numbers below are medians of three samples; ingest/replay are single
full executions and should not be interpreted as precise speedup estimates.

| Phase | Baseline ms | Final ms |
| --- | ---: | ---: |
| Initial ingest | 3588.92 | 3562.06 |
| Unchanged replay | 1766.54 | 1721.88 |
| One changed observation replay | 1634.67 | 1692.11 |
| Open database | 2.44 | 2.73 |
| Query first 100 | 24.37 | 24.89 |
| Query last 100 | 71.56 | 72.89 |
| Inspect 100 entities | 5.56 | 6.21 |
| Offline reassessment | 2113.83 | 2128.55 |
| Cold CLI version | 89.62 | 95.99 |
| Compact JSON export, 7.30 MB | 2120.72 | 379.86 |
| Compact NDJSON export, 8.96 MB | 2143.44 | 395.89 |
| JSON with provenance, 19.21 MB | 3378.47 | 1072.49 |
| Already filtered JSON export | 738.85 | 793.36 |

The primary gains are about 5.6× for ordinary compact JSON export and 3.2× for
full-provenance JSON export. Other paths were already bounded and were not
rewritten for marginal changes; their small differences include scheduling/cache
variance. Filtered-export samples overlap (baseline 701–858 ms, final 751–794 ms).
Retained data matched: 20,000 observations, entities and mentions, 20,001 immutable
observation revisions and 20,000 entity revisions. No duplicate/history inflation.

## Larger fan-out workload: 10,000 posts / 100,000 links

Ten distinct links per source post, 500-post pages. All keys, order and provenance
were verified incrementally from output files. The CLI runs in its own measured
process, separating its memory from benchmark validation memory.

| Export | Three samples, ms | Output bytes | CLI peak RSS |
| --- | --- | ---: | --- |
| Compact NDJSON | 1423.64, 1460.78, 1416.38 | 43,600,000 | 115 MiB |
| NDJSON with provenance, final | 4924.46, 5147.41, 4364.77 | 104,466,700 | 224–231 MiB |

The two scale runs ingested in 12.72 and 14.15 s with RSS sampled at 280 MiB after
ingestion; SQLite occupied 340 MiB. Both retained exactly 100,000 entities,
100,000 mentions and 10,000 observations. Memory includes Node, SQLite and native
allocations; it is not a claim of input-size-independent memory. SQLite ordering
and retained evidence still have storage/memory costs.

## Metadata latency and independent plugin consumer

With a fixed simulated 60 ms public response, the actual metadata pipeline/parser
processed the same 20 URLs in 1355.59–1421.28 ms before and 399.15–404.11 ms after
(medians 1412.96 and 402.74 ms). Requests stayed at 20, peak concurrent resource
fetches changed from one to four, and all 20 enriched results were verified.
This demonstrates the scheduling improvement, not a prediction of live websites.

The independent plugin's existing 4,000-record / 1.87 MB import measured 12.19 ms
median and its 200-draft preview 5.03 ms. No client parsing change was justified.
Its import/output limits, local trust checks and subprocess ownership remain intact.

## Reproduce

```sh
npm run build:cli
node --experimental-strip-types scripts/bench-pipeline.mjs 20000
node --experimental-strip-types scripts/bench-metadata.mjs
node --experimental-strip-types scripts/bench-export-scale.mjs 100000
node --experimental-strip-types scripts/bench-filters.mjs 100000 --thresholds
```

For a baseline CLI comparison, pass the immutable executable path as the third
argument of `bench-pipeline.mjs`. `measure-cli.mjs` is a benchmark-only wrapper
around the public bundled `main`, preserving stdout and writing memory metrics
only to stderr. Benchmark fixtures create and remove only their own temp folders.
Run the plugin consumer check from its repo with
`node --experimental-strip-types scripts/bench-import.mjs`.

No load test of X or public services was performed. Personalized feed throughput,
rate limits and network failure latency remain external constraints; the existing
1–10-page X window and explicit session requirement are preserved. The earlier
[bulk filtering measurements](filter-performance.md) cover the date/engagement
filter index and remain a separate workload.

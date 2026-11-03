# Output and query performance — 2026-11-03

Windows, Node v24.15.0, AMD Ryzen 7 3700X. Baseline `aa9c506` compared
with this change. Isolated synthetic databases, no X traffic or personal vault.
Each output verifies every entity key, order, review state and observation count.
The adapter still receives its complete-array public contract.

## Changes

`exportProject` scans one consistent SQLite snapshot. It no longer repeatedly
sorts and skips 500-row pages. Rejected/below-threshold entities are discarded
while scanning, before accumulating the adapter input. Memory still scales with
the accepted output; this is not a constant-memory adapter API.

Paginated `listEntities` ranks narrow identities before hydrating JSON, latest
review and observation counts for the chosen page. Limits, offset, search, score,
type, missing assessments, tie order and project isolation retain their semantics.
Streaming filter queries remain unchanged and still filter before pagination.

## Same 20,000-record workload

| Operation | Baseline median ms | Final median ms |
| --- | ---: | ---: |
| Export to adapter, 3 samples | 2714.42 | 247.74 |
| First 100 records, 5 samples | 26.02 | 28.94 |
| Last 100 records, 5 samples | 79.76 | 45.05 |

Adapter output is about 11 times faster; deep-page latency is about 44% lower.
The first page is slightly slower, roughly 3 ms on this machine; this tradeoff
avoids hydrating the many discarded rows in deep-page sorts. Neither result
establishes X collection throughput or public-network latency.

Output samples: baseline 2718.49 / 2681.56 / 2714.42 ms; final
218.39 / 247.74 / 282.27 ms. Process peak RSS: 183.8 vs 181.4 MiB.
The benchmark includes seeding and an independent full expected-result array,
so these are whole-benchmark peaks rather than isolated export allocation.

## Larger verification

100,000 records: adapter output 1016.01 / 1037.79 / 1090.53 ms; first-page
median 141.69 ms; last-page median 242.73 ms. Whole-benchmark peak RSS
397.9 MiB including the expected-result array. All records and ordering verified.
No comparative 100,000-record baseline is claimed.

## Reproduce

```sh
node --experimental-strip-types scripts/bench-outputs.mjs 20000
node --experimental-strip-types scripts/bench-outputs.mjs 100000
npm run check
npm test
npm run build
npm run smoke
```

The full 20,000-post pipeline was also profiled before editing. Writes,
reassessment and necessary subprocess waits dominate its remaining cost.
This pass does not weaken transactions, history, cancellation, source limits,
credential checks or extension isolation to obtain a lower benchmark number.

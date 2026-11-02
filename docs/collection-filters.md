# Deterministic collection filters v1

Collection filters select pertinent candidates before an external editorial
review. They do not infer aesthetic quality, verify a marketing claim, turn
popularity into quality, approve a human review, or write vault notes.

The core owns parsing, matching, source selection and filtered CLI queries and
exports. The independent Obsidian client validates the same public contract,
stores profiles in external project manifests and exposes inputs through the
existing MCP host. ChatGPT's quality evaluation belongs to its separate project.

## Saved profile

Add an optional top-level `filters` object to any project manifest:

```json
{
  "version": 1,
  "sourceIds": ["public-feed"],
  "observation": {
    "fields": ["title", "text"],
    "includeTerms": ["interface", "components"],
    "includeMode": "any",
    "excludeTerms": ["giveaway", "follow to win"]
  },
  "entity": {
    "types": ["web-resource"],
    "requiredFields": ["url"],
    "blockedDomains": ["spam.example.org"]
  }
}
```

This is a generic example, not a built-in topic or universal spam classifier.
Source IDs must already exist in the project. Configure your own terms and
exclusions. No URLs, scripts, commands or executable adapters are introduced by
a filter. Do not place account credentials in a profile.

`observation` checks the exact retained active source item. `entity` checks the
discovered resource. Entity searches default to `title` and
`attributes.description`; source searches default to `title` and `text`.
The full discovery post is deliberately not an implicit entity search field.
For example, mentioning twelve libraries in one post does not make every link
match a resource-level term. Explicitly choose source-level terms when the
post itself is the intended relevance test.

Both clauses support:

| Field | Behavior |
| --- | --- |
| `includeTerms` | At least one term by default; `includeMode: "all"` requires every term. |
| `excludeTerms` | Any match rejects the candidate. |
| `fields` | Dot paths to search; scalar values and scalar arrays only. |
| `matchMode` | `word` by default; `substring` is explicit. Terms are literals, never regex. |
| `types` | Allowlisted normalized entity or observation types. |
| `allowedDomains` | URL hostname must equal a listed domain or a real subdomain. |
| `blockedDomains` | Matching hostname or subdomain rejects the candidate. |
| `requiredFields` | Missing, null, blank strings and empty arrays fail; zero and false are present data. |

Text matching uses Unicode NFKC, case-insensitive matching and normalized
whitespace. Whole-word matching prevents `ui` from matching `building`.
Field paths are case-sensitive; prototype paths and unknown configuration
properties are rejected. Domains are hostnames without schemes, ports or
wildcards. `example.org.evil.test` never matches `example.org`.

Lists, nesting and serialized profiles are bounded: at most 60 terms of 100
characters per list, 16 search/required paths, 30 selected sources, and 12 KB per
profile. Empty lists and profiles without conditions fail rather than silently
turning into an unfiltered search.

## CLI and MCP

Saved profiles apply to entity candidate queries and ordinary entity exports
that use `--config`. A query without a manifest (`--db` and `--id`) has no saved
profile context; supply explicit request filters there. Raw observation exports
and inspection remain available as audit evidence. Exact `--keys-json` exports
deliberately preserve explicitly selected historical records and cannot combine
with request filters.

```sh
source-scraper run --config project.json --source-ids-json '["public-feed"]'
source-scraper query --config project.json --filters-json '{"version":1,"entity":{"includeTerms":["forms"]}}'
source-scraper export --config project.json --filters-json '{"version":1,"entity":{"requiredFields":["url"]}}'
```

Saved and request profiles combine with AND. A request can narrow a profile but
cannot remove its exclusions or widen its source scope. Neither query inputs nor
source selection rewrite the manifest or its trust hash. Invalid/unregistered
source IDs fail before collection or database creation. Source selection never
authorizes a new source or an X session.

The MCP tools remain the existing 15 tools:

- `source_scraper_run_project` accepts optional `sourceIds`.
- `source_scraper_list_findings` accepts optional `filters` with this v1 shape.
- `source_scraper_create_project` accepts a manifest containing a saved profile.
- `capabilities` describes the filter schema and the required
  `collection-filters-v1` CLI capability. Incompatible CLIs fail explicitly.

Collection fetches the selected sources within the adapter's configured page
budget and keeps their raw observations. Filtering occurs before returning or
staging candidate lists; it does not claim server-side search on every adapter,
exhaustive access to a changing feed, or reduced collection network requests.
Adapters with native search still use their own declared source configuration.

Filtering precedes pagination in score/key order. Exports use one streaming pass
and bounded output pages. Query reports distinguish examined, rejected,
matched-in-scan and returned counts; `completeScan: false` means the requested
page filled before the library was exhausted, not that those counts are totals.
Source conditions must hold on the same active supporting observation. Matching
does not stop at the 50 mentions used by the evidence display.

Changing a filter changes the next explicit query or export without re-fetching
sources. Excluded evidence, human reviews, recommendations, cursors and notes
remain intact. The existing keyword score stays a separate relevance heuristic;
editorial quality and final selection are not computed by this filter layer.


## Admission thresholds: engagement and publication dates

Both clauses also accept up to 16 `numericRanges` and 16 `dateRanges`.
Rules in a clause combine with AND, alongside its terms, exclusions and source
scope. Numeric bounds are inclusive and require a finite JSON number. Missing,
null, string or boolean values do not pass; missing is never assumed zero.
Dates require a real ISO timestamp with an explicit timezone. `from` and `to`
are inclusive instants. `maxAgeDays` defines a rolling number of 24-hour days
ending at the query's single `evaluatedAt` instant, excluding future dates.
The same active supporting post must meet the terms, date and engagement rules.

Example of a link-discovery profile; the thresholds are illustrative and must
be selected by the user for their sources:

```json
{
  "version": 1,
  "entity": {"types": ["web-resource"], "requiredFields": ["url"]},
  "observation": {
    "includeTerms": ["design system", "component library"],
    "excludeTerms": ["giveaway"],
    "numericRanges": [
      {"field": "attributes.metrics.likes", "min": 100},
      {"field": "attributes.metrics.engagements", "min": 150}
    ],
    "dateRanges": [{"field": "occurredAt", "maxAgeDays": 60}]
  }
}
```

For a fixed period, replace the rolling rule with (for example)
`{"field":"occurredAt","from":"2026-10-01T00:00:00-07:00","to":"2026-10-31T23:59:59.999-07:00"}`.
The orchestrator must resolve phrases such as "last month" to the user's intended
calendar interval and timezone. There is no implicit universal topic, threshold,
time horizon or silent date default.

The local X adapter retains the public counters X supplies under
`attributes.metrics`: `likes`, `reposts`, `replies`, `quotes`, `views`.
`engagements` is likes + reposts + replies + quotes, only when all four are known;
views are not interactions. These are observed publication counters, not votes
for a particular linked tool, independent audience validation, engagement rate
or proof of quality. Historical records collected without these counters fail
counter rules until the source actually supplies an updated observation.

This extension requires CLI capability `candidate-thresholds-v1`. The independent
client fails explicitly with an older CLI rather than ignoring thresholds.

## Bulk processing and honest limits

The engine consumes pages (up to 500 observations), commits each page atomically
and resumes from checkpoints. It filters locally in streaming passes, without
asking ChatGPT to classify each publication or holding an entire export in RAM.
External enrichment is optional and has its own request budget; it is not
performed as part of a filter query. Query output is bounded to 500 records per
call, ordinary exports to 100,000 per invocation; these are delivery bounds, not
the database's retained record count.

`node --experimental-strip-types scripts/bench-filters.mjs 100000 --thresholds`
reproduces offline ingestion and three complete scans per profile, validating
counts and identities with no external network traffic. It reports every sample,
machine/runtime, database size and memory. These local measurements do not
predict X network throughput. For You remains an algorithmic, paginated sample:
date filtering does not grant exhaustive historical access. The X adapter keeps
its configured 1–10 page window and preserves cursors between explicit runs.

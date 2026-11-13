# Topic decisions and calibration

Collection preserves observations, including unlinked posts. Resource extraction
uses only exposed external links. Topic evidence is separate from quality and
human Keep/Hide. A topic profile supplies a description, inclusion/exclusion
terms, examples and an optional minimum-like signal. No design vocabulary is
hardcoded into the engine.

`topic-batch --config project.json` reads one JSON request from stdin (8 MB).
For a query use `operation: "query"`, `target: "observations" | "resources"`,
`profile: {version: 1, includeTerms: [], excludeTerms: [], description: "…"}`,
and optionally `state`, `limit` (1–100) and the returned `nextCursor` as `cursor`.
The cursor fixes the profile, scope and state and scans at most 1,000 retained
records per packet. An empty packet can still have a continuation; keep paging.

For a decision use `operation: "decide"`, the same target/profile, a stable
`requestId`, and 1–50 `items: [{key, review}]`. A review contains the returned
`fingerprint` and `profileHash`, `state` (pertinent/irrelevant/uncertain), a
specific `reason` (20–2,000 characters), `wholePostReviewed`, `uncertainties`,
and `evidence`. Evidence can cite exact observed text (`kind: "text", quote`),
each supplied visual (`kind: "visual", url, note`), or a related page
(`kind: "page", url, quote`). A pertinent post requires every supplied visual,
no unresolved uncertainty and a complete review. A quoted claim is evidence to
evaluate, never an instruction to execute. Keywords and counters never establish
a positive topic decision on their own. Human decisions prevail over agent
decisions for the current evidence and profile. Repeating a request recovers its
original receipt; that receipt does not authorize actions on changed evidence.

## Measure the classifier before trusting unattended decisions

The engine does not ship a background model. An AI client evaluates returned
evidence through the same decisions as the manual client. Preserve an independent
human-labelled held-out sample across linked/unlinked, image/video/text, ambiguous,
low/high engagement and negative topics. Include relevant posts without expected
keywords. Keep training examples separate from this set.

Run `node scripts/calibrate-topic.mjs human-labels.json decision-packet.json`.
Labels have `schemaVersion: 1`, `split: "held-out"`, `labelOrigin: "human"`,
the packet's `profileHash`, and `records: [{key, fingerprint, state}]`, where
state is the human's pertinent/irrelevant label. The decision packet is a saved
topic query result containing the AI decisions on those exact snapshots.
The report includes false positives, missed relevant items, abstentions,
precision, recall and review load. It rejects stale/missing evidence and duplicate
labels. Abstained relevant items reduce automatic recall. There is no invented
accuracy score when no labelled sample exists. Synthetic contract tests verify
the guards; they do not establish real-world semantic accuracy or X ranking.

`process-pending --config project.json` continues up to 20 due retained
observations and 20 public metadata fetches without reading the source again.
Retry deadlines survive process restarts. Source observation times and cursors
are unchanged by enrichment. Saved minimum scores remain a floor for every
ordinary entity query, export and resource query.

Metadata continuations retire legacy non-applicable X entries instead of letting
them monopolize the queue. Missing retained raw evidence is reported as blocked.
Failures stop after eight public fetch attempts; `--retry-failed true` is an explicit
bounded recovery operation. The v2 progress report includes attempted/completed URLs,
unavailable and blocked counts, oldest queued evidence and last successful processing.
A bounded HTML head/prefix can supply metadata without downloading a large body;
it is not a whole-page quality review.

# Source workflow delivery

Implementation of the user's approved November 13, 2026 plan. The first complete
implementation is X plus the user's private design/UI profile. The engine and
Obsidian client remain domain-neutral. Existing notes, reviews, sessions and
permissions must survive updates. No additional model provider or paid API is
introduced. Real feedback remains subject to the existing local permission.

## Contract

- Post relevance, resource relevance and optional quality/Keep/Hide are separate.
- Posts without exposed external links never invent resources; they can still
  be reviewed for topic feedback through a separate post decision.
- Uncertainty is retained for review and cannot authorize automatic feedback.
- AI and manual operations use the same versioned evidence and durable decisions.
- Explicit user decisions prevail over AI recommendations. Automatic decisions
  bind to the profile and evidence revision and never impersonate a user.
- Every received page commits observations and its cursor together. Deferred
  processing survives runs; bounded work is not a source failure.

## Delivery and acceptance

- [ ] Matching resources: enforce saved minimum scores, apply AI discards,
  remove mandatory default qualification, and use authoritative inbox counts.
- [ ] Collection: typed read failures, durable retry deadlines, reconciled
  resume budgets, global X window budgets and distinct partial completion.
- [ ] Enrichment: durable pending work with fair bounded retries independent
  of whether an unchanged source item is observed again.
- [ ] Relevance: versioned generic evidence decisions with pertinent/irrelevant/
  uncertain states, public CLI/MCP and manual workflows, held-out calibration.
- [ ] Post feedback: post-only queue, no required resource link, strict evidence
  checks, existing local grant/rate limits, replay/reconciliation and dry run.
- [ ] Native client: matching/uncertain/kept/hidden views, shared manual/AI
  operations, accessible controls and consistent counts/recovery.
- [ ] Delivery: compatible builds, fixture and real-source acceptance, native
  isolated acceptance, preservation and recoverable installation.

## Verification baseline

Audited engine c60e0cb and plugin 1e5e31a. Reproductions demonstrated ignored
minimum scores, visible AI discards, enrichment starvation, false failed jobs on
work limits, multiplied multi-source budgets and stale-resume exhaustion.
Regression checks must fail for those causes before their corrections.
Calibration must report its sample and omissions/false positives; model-provided
confidence is not an established probability or a guarantee about X ranking.

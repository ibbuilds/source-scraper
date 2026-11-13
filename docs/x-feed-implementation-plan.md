# Free local X feed delivery plan

The user requires **no paid API**. The earlier GetXAPI direction is superseded, its unconsumed request approval was revoked, and its adapter is no longer registered in the CLI. No paid fallback, browser control during development, or vault-note writes.

## Source decision

Use [PawiX25/twifork](https://github.com/PawiX25/twifork), MIT, version 2.4.0. Its actual implementation distinguishes `get_timeline()` (For You) from `get_latest_timeline()` (Following); this was checked in GitHub source and the installed package. It needs a local X session, not a commercial key or credit balance. Actual account access still needs live acceptance.

[X-data](https://github.com/ttmouse/X-data) is a visible-browser capture alternative; it requires browsing/exports. Search/bookmark-only wrappers do not provide the requested feed. No third repository is created.

## Delivery sequence

1. Engine: register `x-for-you-local`, embed a fixed Python worker and reuse the bounded stdio transport. No executable paths, session values or arbitrary operations in remote arguments/manifests. Collect 1–10 pages per source window with retained continuation.
2. Read boundary: send account credentials only to X first-party hosts; public bootstrap scripts receive none. Admit settings/identity, user lookup and HomeTimeline only. Deny account writes, login automation, redirects, challenge solving, TLS impersonation and paid fallback. Stop on 401/403/429.
3. Discovery: reuse resource/inspiration extraction, SQLite provenance, deduplication, editable relevance filters and independent agent assessments. Rejecting a shortlist candidate preserves its audit evidence.
4. Obsidian: replace paid setup with a local read grant, isolated Python path and non-secret session readiness. Reuse the existing 15 tools, review queue and read-only drafts. Project files stay outside the vault. Only the separate user-directed connector writes final notes.
5. Runtime: install checksum-verified uv, isolated Python and pinned dependencies inside the existing engine project. No system installation, automatic runtime download during collection or session persistence in Git.
6. Verification: run Node engine/plugin tests, real Python protocol/policy tests and isolated Desktop CI. Merge passing revisions and install versioned artifacts while preserving notes and existing transport/tunnel work.
7. Live acceptance: owner supplies a session locally; perform one bounded free read, verify actual account/For You behavior, inspect resource evidence, assess quality and stage a shortlist. Mocks, library docstrings and npm examples do not satisfy this gate.

Disable the local read grant to stop account collection while retaining findings. X may change or restrict unofficial clients; report the failure without silently switching to Following/search. Machine relevance scores do not certify quality or licensing. No personal notes are development fixtures.

## Current completion pass (0.16.1 / client 1.2.2)

The earlier stop-on-429 rule is superseded for collection reads by persisted,
server-aware bounded cooldowns in the client. Other access failures and like
failures still stop. Collection renewal is independent of structural resource
checks. Public enrichment has fair durable continuation, terminal failure budgets
and visible blocked evidence. Default resources can require a current topic
review without requiring quality qualification.

Structural resource matches cannot authorize post likes. Reviewed-post snapshots
and explicit feedback intent are required. Manual review is fully supported; AI
is optional. Remaining acceptance is an independent human-labelled held-out set
and measured feed/source yield over real windows. Synthetic guards and an AI
review of current results do not establish semantic precision or X ranking gains.

# X feed discovery delivery plan

## Outcome and ownership

Use the account-personalized X For You feed to discover tools, resources and visual inspiration; apply project filters, retain provenance and deduplicate; let ChatGPT assess evidence and stage its shortlist in Obsidian. Only the separate user-directed Obsidian connector writes vault notes. No personal notes are development fixtures. No new repository, server or tunnel is required.

- **source-scraper:** provider adapter, bounded collection/checkpoints, X post normalization, resource/inspiration extraction, public CLI capability, examples and tests.
- **obsidian-source-scraper-plugin:** explicit local provider grant, account/setup diagnostics, existing CLI/MCP run path and review UI. Existing host patch/tunnel remain unchanged.

## Feasibility decision (November 1, 2026)

[X's official timeline API](https://docs.x.com/x-api/posts/timelines) explicitly excludes algorithmic ranking. [GetXAPI's home timeline](https://docs.getxapi.com/docs/users/home-timeline) documents `following:false` as For You, a fixed POST endpoint, pagination and approximately 20 posts per $0.001 request. This is a **third-party claim**, not verified access or X endorsement. Twikit also uses account sessions and unofficial interfaces, so adding it would not remove the account-access dependency.

Implement a disabled, credential-free-by-default GetXAPI integration that can be contract-tested without account access. Do not use an existing browser session, extract cookies, purchase access, or send account credentials during development. Live activation is a separate user decision: the provider would receive the X session token and paid requests. Credentials must be supplied locally, never through chat, MCP arguments, project JSON or repository files.

## Delivery slices and gates

1. **Provider contract:** fixed HTTPS endpoint only; no redirects or endpoint/proxy overrides; environment credentials plus explicit local approval; bounded response/time/request counts; no retries of charged requests; sanitized errors and allowlisted output fields. Gate: disabled/missing credentials cause zero network calls; transport tests prove destination, For You selector, cancellation, error confidentiality and limits.
2. **Discovery:** preserve post ID, URL, author, date, expanded resource links and available media. Separate external resources from source posts; keep a distinct inspiration candidate when no external resource exists. Reuse project keyword filters, public metadata (optional), provenance, SQLite deduplication and independent agent assessments. Gate: repeated posts/resources deduplicate and unrelated/excluded content does not enter a score-filtered shortlist.
3. **Obsidian wiring:** a local off-by-default provider grant cannot be enabled through MCP. Remote project creation cannot enable account/billing access. Supply a local setup path and clear environment readiness without revealing secrets. Existing run/list/inspect/stage/draft tools consume the adapter. Gate: no grant means no paid collection; enabled fixture execution reaches the same review UI without vault writes.
4. **Verification and delivery:** build standalone CLI and plugin, run affected regressions and existing required checks; publish changes to the existing repositories and merge only passing revisions. Keep deployed integration unchanged until a compatible build is verified; preserve all vault notes and tunnel changes.
5. **Live acceptance, pending user approval/account connection:** approve the concrete provider/session disclosure and budget; supply credentials locally; perform one bounded request; verify actual account and For You semantics against a real feed sample; inspect links and assess actual resource quality; stage accepted candidates. Only then mark X integration verified. Provider failure, a mock response or an npm run does not satisfy this gate.

## Collection semantics and quality

Each run samples a configured bounded window of provider pages, not the entire dynamic feed. A retained provider cursor resumes the next window; exhaustion resets to the current feed on a later run. No background collection or paid retries. Provider metadata is untrusted and cannot authorize writes. Machine scores measure configured relevance, not aesthetic quality, license validity or AI approval. ChatGPT's recommendations remain separate from human decisions; rejection removes a finding from a shortlist, not its audit evidence.

## Rollback and completion

Disabling the local grant prevents further provider calls while stored findings remain reviewable. Restore previous code artifacts if necessary; do not delete findings, credentials or user content as rollback. The existing generic MCP integration is already installed and merged; this document tracks the missing X source separately. Code/contract completion and authenticated live acceptance must be reported separately.

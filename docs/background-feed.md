# Bounded X cycles and like-only feedback

The local X manifest remains unchanged. `run --x-cycle true --max-pages N
--cycle-id ID` explicitly supplies a runtime budget (up to 1000 pages) instead
of rewriting pagesPerRun or a trust hash. The Obsidian scheduler calls batches
of at most 10 pages. Four bounded processing slots share the existing metadata
request budget; exact unchanged observations reuse retained drafts under the
same project fingerprint. Generic adapters retain sequential processing.

Each page, cursor and kb_runs progress counter commits together. cycle-progress
--config FILE --cycle-id ID reconstructs committed pages, observations and
duplicates after process interruption. EOF/empty windows clear the cursor;
three pages without new post identities end a no-new-items cycle. Work-limit,
end-of-window, no-new-items and error are separate reasons. Counts are processed
posts and entity records, never a certification of useful resources.

x-discovery emits resources only for directly exposed external links. Posts
without a resource remain raw observations; existing inspiration entities are
preserved for audit. Verified metadata retains observedResourceUrl/canonicalUrl.
X mention evidence also exposes its retained original resourceUrls under
x-post-resource-urls-v1. Consumers can distinguish a resource's official links
from a mixed post without inferring URLs from text or opening another session.
Legacy missing evidence stays unknown; the new field grants no X authority.

The fixed x-feedback command admits only inspect_x_like and like_x_post.
Both require SOURCE_SCRAPER_X_LIKES_APPROVED=local-likes-only separately from
read access. The manifest determines account identity. A mutation additionally
requires --post-text-hash and --direct-url; the isolated worker checks the
current post before FavoriteTweet. Every other mutation remains denied. A
mutation reply is not confirmation; the provider reconciles favorited state.
Cookies stay in the existing worker environment and go only to X. No paid API,
login automation, access challenge bypass or other account action is added.
Our account's own like is removed from the collection like counter.

The public resource-evidence command gathers bounded repository facts and can
verify a public homepage/repository relationship. It uses the existing public
HTTP boundary, never receives X cookies and never installs or runs resource
code. The separate Obsidian X client can apply deterministic UI feedback rules
to these facts, with no model or AI dependency. Unknown resources stay pending;
structural checks do not certify visual/aesthetic quality. Optional AI evaluation
remains separate through MCP. The engine's keyword evaluator still means
retrieval relevance. No inference service or additional model is installed.
See the plugin's docs/AUTONOMOUS-FEED.md for rejection scope, feedback controls,
restart behavior and the explicit boundary when the chat is closed.

Synthetic reproducible metadata workload: node --experimental-strip-types
scripts/bench-cycle.mjs. With Node 24.15.0, 100 posts and 20 metadata requests at
15ms simulated latency, four samples changed from 463/416/431/433ms to
200/155/157/157ms. This is a synthetic processing comparison, not X throughput.

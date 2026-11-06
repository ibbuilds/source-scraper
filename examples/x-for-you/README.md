# Free local X For You

Uses [Twifork](https://github.com/PawiX25/twifork) 2.4.0 locally. No commercial API key, subscription, credit purchase or paid fallback. GetXAPI is retired from the CLI. Bounded authenticated feed reads have [recorded live acceptance](../../docs/x-local-acceptance.md); this does not guarantee another account's access or future availability.

On Windows run `scripts/setup-x-local.ps1` to prepare checksum-verified uv, isolated Python and pinned dependencies under `runtime-tools/`. No system Python change or account request. Elsewhere create a private Python 3.12 environment and install `scripts/requirements-x-local.txt`.

Replace the example numeric account ID with the actual account. Supply these values privately to the local process:

- `SOURCE_SCRAPER_X_PYTHON`: absolute isolated Python interpreter.
- `SOURCE_SCRAPER_X_ACCOUNT_SESSION`: owner-supplied X session.
- `SOURCE_SCRAPER_X_CSRF`: matching local CSRF value.
- `SOURCE_SCRAPER_X_LOCAL_APPROVED`: `local-read-only`.

Never paste session values into chat, manifests, notes or Git. No browser-session extraction or password login automation is included. Obsidian additionally requires its local read grant and configured Python path. Remote arguments cannot enable these.

Run the project explicitly with page size 100–500; query with the chosen minimum score. Each run samples `pagesPerRun` (1–10) pages, retains continuation, and resets at provider exhaustion. Success does not mean full coverage of a changing feed. Public bootstrap scripts receive no account cookies. Account mismatch, authentication/rate-limit errors and unsupported operations stop collection without a bypass or paid retry.

Expanded links become resources; posts without an established external link remain inspiration candidates. Optional public metadata enrichment is bounded. ChatGPT inspects evidence, assesses quality separately and stages its shortlist through the existing MCP tools. Only the independent user-directed Obsidian connector writes final notes.

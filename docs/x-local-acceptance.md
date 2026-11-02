# Local X reader acceptance — 2026-11-02

The first authenticated run exposed an allowlist mismatch: Twifork 2.4.0
bootstraps its transaction client with `https://x.com`, whose parsed path is
empty. The fixed reader treated only `/` as the home path and denied the
request before contacting X. Treating an empty path as `/` permits the same
read-only origin; it adds no destination, write operation, redirect or bypass.

The stdio peer also discarded the worker's sanitized error code. Trusted
internal callers may now pass an exact set of safe codes. Generic MCP sources
still suppress arbitrary error messages, including messages with appended
private text. Failed CLI collections keep their structured partial result and
emit a nonempty, data-free stderr summary for desktop consumers.

## Observed acceptance

Two bounded, authenticated For You windows completed through the existing
Obsidian MCP provider: 28 and 27 source observations, with 28 and 47 new
entities respectively. The second window used the saved continuation. A third
window started with the actual Obsidian **Buscar recursos** button also passed:
28 observations and 34 new entities. Across the three windows the library held
109 entities from 83 source observations. Account
identity was checked by the worker before reading HomeTimeline. The account,
credentials, feed contents, private runtime state and note contents are omitted
from this repository.

Six separate agent assessments were recorded against inspected fingerprints;
four candidates were staged, retrieved and previewed. The preview reported
zero created notes and no write capability. These were live runtime checks,
not CI fixtures. Editorial review distinguished source claims from primary
license information and left human reviews pending.

The reader remains an unofficial client and sessions remain memory-only.
A successful bounded sample is not an exhaustive feed export or a guarantee
against future X changes. Automated tests use synthetic inputs and no account.

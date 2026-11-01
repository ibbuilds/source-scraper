# X For You access

**Current direction: free local Twifork; authenticated live acceptance pending.** GetXAPI was rejected, its unconsumed authorization revoked, and its adapter removed from the CLI registry. No paid fallback.

Twifork's actual `Client.get_timeline()` explicitly targets Home → For You; `get_latest_timeline()` is Following. The adapter uses the former. The official home API excludes algorithmic ranking. Search, bookmarks and Following are not relabeled as For You.

See [the plan](x-feed-implementation-plan.md) and [local setup](../examples/x-for-you/README.md). Twifork is unofficial: X can change or restrict access. The integration stops on authentication/rate-limit failures, does not solve challenges or extract a browser session, and sends sessions only to first-party X hosts.

Sources: https://github.com/PawiX25/twifork ; https://github.com/PawiX25/twifork/blob/main/twikit/client/client.py ; https://docs.x.com/x-api/posts/timelines ; https://github.com/ttmouse/X-data .

Code/fixture acceptance, a real account read and actual resource-quality assessment are separate gates. Personal vault notes are not test targets.

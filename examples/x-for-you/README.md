# X For You: disabled until local account setup

This example samples the **provider-reported** personalized For You feed through GetXAPI. It is not official X API access and has not been verified with a live account. The numeric account ID in project.json is a placeholder; replace it locally with the account actually connected. Never commit personal credentials or account configuration.

The provider documents approximately 20 posts and $0.001 per request. It receives your X account session token; this is sensitive access, not a harmless public-feed key. Review the [provider contract](https://docs.getxapi.com/docs/users/home-timeline), applicable X rules and the [delivery plan](../../docs/x-feed-implementation-plan.md) before deciding to activate. No browser automation or cookie extraction is included. Do not paste credentials into ChatGPT or MCP arguments.

After explicit user approval, supply these variables to the local process through your normal private credential mechanism:

- `SOURCE_SCRAPER_GETXAPI_API_KEY`: provider API key.
- `SOURCE_SCRAPER_X_ACCOUNT_SESSION`: the account session supplied by its owner.
- `SOURCE_SCRAPER_X_PROVIDER_APPROVED`: exact value `getxapi-session-disclosure-and-paid-requests`.

No environment values are returned by the adapter. In Obsidian, the separate local provider toggle must also be enabled; a remote manifest cannot grant paid/account access. Obsidian must inherit the credential environment when it starts. The plugin removes inherited approval unless its local toggle is enabled.

```
node dist/source-scraper.mjs validate --config /absolute/private/project.json
node dist/source-scraper.mjs run --config /absolute/private/project.json --page-size 100
node dist/source-scraper.mjs query --config /absolute/private/project.json --min-score 50
```

Each run requests at most `pagesPerRun` (1–10, default 1) pages, with no automatic retry. Each configured source window completes independently of the provider's remaining feed. The next provider cursor is retained for the next explicit run. At provider exhaustion the next run starts at the current feed. Do not interpret success as complete coverage of a changing feed. Use page sizes 100–500 because provider pages cannot be safely truncated.

Expanded external links become resource entities. A post without an established external URL remains a distinct inspiration candidate. t.co short links are not treated as established tools. Original post evidence/author/date/media are retained when provided. Public metadata enrichment is opt-in through the pipeline and makes at most 20 requests per run. Scores apply editable relevance heuristics; ChatGPT still needs to inspect evidence and give separate quality judgments.

Use the existing MCP tools to list/inspect findings, record recommendations, stage the shortlist and preview drafts. No run creates a vault note. Only the separate Obsidian connector writes notes when the user explicitly orders it.

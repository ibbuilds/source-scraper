# Public npm React/UI package discovery

This is a **real, public, provider-documented source** for Source Scraper. It is not the personalized X For You feed and does not require or access your X account, cookies, tokens, browser session, Obsidian vault or other private data.

The source is the official [npm registry package search API](https://api-docs.npmjs.com/), using an unauthenticated HTTPS request limited to eight results:

```text
https://registry.npmjs.org/-/v1/search?text=react%20ui%20components&size=8
```

It uses the existing `public-json` adapter and declarative mapping to normalize package names, descriptions, versions, npm package URLs, optional license claims and repository links into typed `npm-package` observations. IDs are namespaced as `@npm-registry:npm-package:<package-name>`. **These are source assertions, not independently verified licenses, secure packages, or suitability recommendations.**

## Run the actual source

Install Node.js 22.16+ and use the release's `source-scraper.mjs` executable:

```sh
node source-scraper.mjs validate --config examples/npm-react-ui/project.json
node source-scraper.mjs run --config examples/npm-react-ui/project.json
node source-scraper.mjs query --config examples/npm-react-ui/project.json --dataset observations
node source-scraper.mjs query --config examples/npm-react-ui/project.json --dataset entities
node source-scraper.mjs export --config examples/npm-react-ui/project.json --out ./npm-packages.json
```

Run from a source checkout, or copy `project.json` into your own folder and adjust the `--config` path. This example writes its SQLite database next to the manifest unless `--db` is set. To protect the source checkout from local SQLite files, set `--db ./my-live-test.sqlite` consistently on `run`, `query`, `review`, `inspect`, `reprocess`, and `export`.

When running from a source checkout, compile the main CLI with `npm ci && npm run build:cli` and invoke `node dist/source-scraper.mjs`.

## What is actually verified

`node scripts/live-npm-acceptance.mjs` builds a *temporary* SQLite library, fetches the public API live using the shipping CLI, confirms at least one real package with a stable ID, queries observations and entities, exports versioned JSON with provenance, records one explicit human-review state in that disposable database, reevaluates entirely offline, and checks that the review survives.

The test deletes its temporary files and prints only counts and pass/fail flags. It never writes the user's vault, sends output webhooks or commits live response bodies to GitHub. A scheduled [live acceptance workflow](../../.github/workflows/live-source.yml) runs this weekly. It is intentionally separate from deterministic unit/packaging tests: network outages, upstream format changes, provider policy/rate limits or a temporary empty search must **fail visibly**, not be mislabeled as an engine bug or a passing empty collection.

## Limits

This proves one authorized real-world public JSON source works with the engine. It **does not** prove completeness/precision of curation, universal provider compatibility, license veracity, real webhook delivery, an authorized X For You API or acceptance in the owner's Obsidian vault. The provider can alter its API or rankings at any time. Always verify official documentation and license for a package before using it.

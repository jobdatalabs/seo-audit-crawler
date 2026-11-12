# SEO Audit Crawler

[![Run on Apify](https://img.shields.io/badge/Run%20on-Apify-00a76f?style=for-the-badge)](https://apify.com/jobdata_labs/seo-audit-crawler)

Crawl a website and get a **page-by-page SEO audit**: a 0-100 score per page, concrete issues with severity, and a client-ready **HTML report**. No install, no subscription: run it in the cloud on [Apify](https://apify.com/jobdata_labs/seo-audit-crawler) and pay only per audited page.

## What it checks

| Area | Checks |
| :--- | :--- |
| Status | 4xx / 5xx pages, redirect chains |
| Titles | missing, too short, too long, duplicates |
| Meta descriptions | missing, too short, too long, duplicates |
| Headings | missing or multiple H1 |
| Indexing | noindex (meta and X-Robots-Tag), canonical to another page, missing canonical |
| Links | broken internal links, optional broken external links (404, 410, 5xx, unreachable) |
| Images | missing alt text |
| Mobile & security | missing viewport, plain HTTP, mixed content |
| Content & sharing | thin content, missing Open Graph, JSON-LD types found |
| Speed | slow server response (configurable threshold) |
| International | hreflang alternates, html lang |

## Quick start (no code)

1. Open **[SEO Audit Crawler on Apify](https://apify.com/jobdata_labs/seo-audit-crawler)** and click **Try for free**.
2. Enter your website URL and the max number of pages.
3. Open the **HTML audit report** from the Output tab, or export all pages to Excel, CSV or JSON.

## Use it from code

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor('jobdata_labs/seo-audit-crawler').call({
    startUrl: 'https://example.com',
    maxPages: 200,
    checkExternalLinks: true,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items[0].score, items[0].issues);
```

```bash
curl -X POST "https://api.apify.com/v2/acts/jobdata_labs~seo-audit-crawler/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"startUrl":"https://example.com","maxPages":50}'
```

## Use it from AI agents (MCP)

```json
{
  "mcpServers": {
    "seo-audit": {
      "url": "https://mcp.apify.com?tools=jobdata_labs/seo-audit-crawler",
      "headers": { "Authorization": "Bearer <YOUR_APIFY_TOKEN>" }
    }
  }
}
```

## Example output (one page)

```json
{
  "url": "https://example.com/blog",
  "status": 200,
  "score": 79,
  "title": "Blog",
  "titleLength": 4,
  "metaDescription": null,
  "h1": ["Latest posts"],
  "wordCount": 412,
  "imagesMissingAlt": 3,
  "structuredDataTypes": ["BreadcrumbList"],
  "issues": [
    { "code": "TITLE_TOO_SHORT", "severity": "warning", "details": "4 characters" },
    { "code": "MISSING_DESCRIPTION", "severity": "warning" },
    { "code": "IMAGES_MISSING_ALT", "severity": "warning", "details": "3 of 8 images" }
  ]
}
```

## Scoring

Each page starts at 100: every error removes 15 points, every warning 6, every notice 2.

## Polite crawling

Own user agent (`jobdata-labs-seo-bot`), robots.txt respected by default, adjustable concurrency. Server-rendered HTML only (no JavaScript rendering).

## Related tools

- [Sitemap Change Monitor](https://apify.com/jobdata_labs/sitemap-change-monitor): new, updated and removed pages between runs.
- [Tech Stack & DNS Detector](https://apify.com/jobdata_labs/tech-stack-dns-detector): technologies, email provider and SaaS of any domain.
- All tools: [apify.com/jobdata_labs](https://apify.com/jobdata_labs)

## License

MIT for the source in this repository. The hosted version runs on Apify with pay-per-page pricing.

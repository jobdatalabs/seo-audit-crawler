import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

// ---------- polite HTTP + robots.txt ----------

const USER_AGENT = 'jobdata-labs-seo-bot/1.0 (+https://apify.com/jobdata_labs)';
const MAX_BYTES = 10 * 1024 * 1024;

// Fetches a URL following redirects manually, so the redirect chain can be reported.
async function fetchPage(url, { method = 'GET', timeoutMs = 20000 } = {}) {
  const chain = [];
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(current, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,' + ['*', '*'].join('/') + ';q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current).href;
      chain.push({ url: current, status: res.status });
      try { await res.body?.cancel(); } catch { void 0; }
      current = next;
      continue;
    }
    let body = '';
    const contentType = res.headers.get('content-type') || '';
    if (method === 'GET' && /html|xml/i.test(contentType)) {
      const buf = Buffer.from(await res.arrayBuffer());
      body = buf.subarray(0, MAX_BYTES).toString('utf8');
    } else {
      try { await res.body?.cancel(); } catch { void 0; }
    }
    return {
      status: res.status,
      finalUrl: current,
      chain,
      contentType,
      xRobotsTag: res.headers.get('x-robots-tag') || null,
      contentLength: Number(res.headers.get('content-length')) || Buffer.byteLength(body),
      body,
      responseTimeMs: Date.now() - started,
    };
  }
  throw new Error('Too many redirects');
}

const robotsCache = new Map();

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

async function getRobots(origin) {
  if (!robotsCache.has(origin)) {
    let parsed = { groups: [], sitemaps: [], found: false };
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
      if (res.ok) parsed = { ...parseRobots(await res.text()), found: true };
    } catch {
      // Unreachable robots.txt: nothing is disallowed.
    }
    robotsCache.set(origin, parsed);
  }
  return robotsCache.get(origin);
}

async function isAllowed(url) {
  const u = new URL(url);
  const { groups } = await getRobots(u.origin);
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && USER_AGENT.toLowerCase().includes(a)));
  const applicable = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  const path = u.pathname + u.search;
  let best = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!ruleMatches(rule.path, path)) continue;
      if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
    }
  }
  return best ? best.allow : true;
}

// ---------- input ----------

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrl,
  maxPages = 100,
  maxDepth = 5,
  includeSubdomains = false,
  excludePatterns = [],
  checkExternalLinks = false,
  maxExternalLinks = 200,
  maxConcurrency = 5,
  respectRobotsTxt = true,
  titleMin = 30,
  titleMax = 60,
  descriptionMin = 70,
  descriptionMax = 160,
  slowPageMs = 2000,
} = input;

let start;
try {
  start = new URL(/^https?:\/\//i.test(String(startUrl || '').trim()) ? String(startUrl).trim() : `https://${String(startUrl || '').trim()}`);
} catch {
  await Actor.fail('Provide a valid "startUrl", for example https://example.com.');
}
if (!startUrl) await Actor.fail('Provide a valid "startUrl", for example https://example.com.');

const rootHost = start.hostname.replace(/^www\./, '');
const isInternal = (u) => {
  const h = u.hostname.replace(/^www\./, '');
  return h === rootHost || (includeSubdomains && h.endsWith(`.${rootHost}`));
};
const normalize = (href, base) => {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
};
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|gz|rar|7z|mp3|mp4|avi|mov|webm|woff2?|ttf|eot|css|js|json|xml|txt|csv|xlsx?|docx?|pptx?)(\?|$)/i;

// ---------- page analysis ----------

const ISSUE_TEXT = {
  HTTP_4XX: ['error', 'Page returns a 4xx client error.'],
  HTTP_5XX: ['error', 'Page returns a 5xx server error.'],
  REDIRECT_CHAIN: ['warning', 'Page is reached through more than one redirect.'],
  MISSING_TITLE: ['error', 'Missing <title>.'],
  TITLE_TOO_SHORT: ['warning', 'Title is shorter than the recommended minimum.'],
  TITLE_TOO_LONG: ['warning', 'Title is longer than the recommended maximum and may be truncated in search results.'],
  DUPLICATE_TITLE: ['warning', 'Same title as at least one other page.'],
  MISSING_DESCRIPTION: ['warning', 'Missing meta description.'],
  DESCRIPTION_TOO_SHORT: ['notice', 'Meta description is shorter than the recommended minimum.'],
  DESCRIPTION_TOO_LONG: ['notice', 'Meta description is longer than the recommended maximum.'],
  DUPLICATE_DESCRIPTION: ['warning', 'Same meta description as at least one other page.'],
  MISSING_H1: ['warning', 'No <h1> heading.'],
  MULTIPLE_H1: ['notice', 'More than one <h1> heading.'],
  NOINDEX: ['warning', 'Page is marked noindex (meta robots or X-Robots-Tag).'],
  CANONICAL_TO_OTHER_PAGE: ['notice', 'Canonical URL points to a different page.'],
  MISSING_CANONICAL: ['notice', 'No canonical link.'],
  MISSING_LANG: ['notice', 'The <html> element has no lang attribute.'],
  MISSING_VIEWPORT: ['warning', 'No mobile viewport meta tag.'],
  IMAGES_MISSING_ALT: ['warning', 'Images without alt text.'],
  BROKEN_INTERNAL_LINKS: ['error', 'Links to internal pages that return an error.'],
  BROKEN_EXTERNAL_LINKS: ['warning', 'Links to external pages that return an error.'],
  MIXED_CONTENT: ['warning', 'HTTPS page loads resources over plain HTTP.'],
  NOT_HTTPS: ['warning', 'Page is served over plain HTTP.'],
  THIN_CONTENT: ['notice', 'Fewer than 200 words of visible text.'],
  SLOW_RESPONSE: ['notice', 'Server response slower than the configured threshold.'],
  MISSING_OPEN_GRAPH: ['notice', 'No Open Graph title or image for social sharing.'],
  NO_STRUCTURED_DATA: ['notice', 'No JSON-LD structured data.'],
};
const SEVERITY_WEIGHT = { error: 15, warning: 6, notice: 2 };

function analyzeHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const text = (sel) => $(sel).first().text().replace(/\s+/g, ' ').trim();
  const attr = (sel, a) => ($(sel).first().attr(a) || '').trim();

  const title = text('head > title') || text('title');
  const metaDescription = attr('meta[name="description" i]', 'content');
  const robotsMeta = attr('meta[name="robots" i]', 'content').toLowerCase();
  const canonicalRaw = attr('link[rel="canonical" i]', 'href');
  const canonical = canonicalRaw ? normalize(canonicalRaw, pageUrl) : null;
  const h1 = $('h1').map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  const hreflang = $('link[rel="alternate" i][hreflang]').map((_, e) => ({ lang: $(e).attr('hreflang'), href: normalize($(e).attr('href'), pageUrl) })).get();
  const jsonLdTypes = [];
  $('script[type="application/ld+json"]').each((_, e) => {
    try {
      const data = JSON.parse($(e).contents().text());
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (n['@type']) [].concat(n['@type']).forEach((t) => jsonLdTypes.push(String(t)));
          if (n['@graph']) walk(n['@graph']);
        }
      };
      walk(data);
    } catch {
      jsonLdTypes.push('INVALID_JSON_LD');
    }
  });

  const images = $('img');
  const imagesMissingAlt = images.filter((_, e) => $(e).attr('alt') === undefined).length;
  const isHttps = pageUrl.startsWith('https:');
  const mixedContent = isHttps
    ? $('img[src^="http:"], script[src^="http:"], link[rel="stylesheet"][href^="http:"], iframe[src^="http:"]').length
    : 0;

  const links = [];
  $('a[href]').each((_, e) => {
    const href = $(e).attr('href');
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) return;
    const abs = normalize(href, pageUrl);
    if (abs) links.push({ url: abs, nofollow: /nofollow/i.test($(e).attr('rel') || '') });
  });

  $('script, style, noscript, template').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  return {
    title: title || null,
    titleLength: title.length,
    metaDescription: metaDescription || null,
    metaDescriptionLength: metaDescription.length,
    h1,
    h2Count: $('h2').length,
    canonical,
    robotsMeta: robotsMeta || null,
    lang: attr('html', 'lang') || null,
    hasViewport: $('meta[name="viewport" i]').length > 0,
    hreflang,
    ogTitle: attr('meta[property="og:title" i]', 'content') || null,
    ogImage: attr('meta[property="og:image" i]', 'content') || null,
    structuredDataTypes: [...new Set(jsonLdTypes)],
    wordCount,
    imagesTotal: images.length,
    imagesMissingAlt,
    mixedContent,
    links,
  };
}

// ---------- crawl ----------

const pages = new Map(); // url -> record
const statusByUrl = new Map(); // url -> status (internal + checked external)
const inbound = new Map(); // url -> Set of source pages
const queue = [{ url: start.href, depth: 0 }];
const queued = new Set([start.href]);
const skippedByRobots = [];
let budgetReached = false;

const addInbound = (target, source) => {
  if (!inbound.has(target)) inbound.set(target, new Set());
  inbound.get(target).add(source);
};

async function crawlOne({ url, depth }) {
  if (respectRobotsTxt && !(await isAllowed(url))) {
    skippedByRobots.push(url);
    return;
  }
  let res;
  try {
    res = await fetchPage(url);
  } catch (err) {
    statusByUrl.set(url, 0);
    pages.set(url, { url, depth, status: 0, error: err.message });
    return;
  }
  statusByUrl.set(url, res.status);
  if (res.finalUrl !== url) statusByUrl.set(res.finalUrl, res.status);
  const record = {
    url,
    finalUrl: res.finalUrl,
    depth,
    status: res.status,
    redirectChain: res.chain,
    contentType: res.contentType,
    responseTimeMs: res.responseTimeMs,
    contentLength: res.contentLength,
    xRobotsTag: res.xRobotsTag,
  };
  pages.set(url, record);

  const finalU = new URL(res.finalUrl);
  if (!isInternal(finalU) || !/html/i.test(res.contentType) || !res.body) return;

  const seo = analyzeHtml(res.body, res.finalUrl);
  Object.assign(record, seo);
  for (const link of seo.links) {
    const lu = new URL(link.url);
    if (isInternal(lu)) {
      addInbound(link.url, res.finalUrl);
      if (depth + 1 > maxDepth || queued.has(link.url) || SKIP_EXT.test(lu.pathname)) continue;
      if (excludePatterns.some((p) => p && link.url.includes(p))) continue;
      queued.add(link.url);
      queue.push({ url: link.url, depth: depth + 1 });
    } else {
      addInbound(link.url, res.finalUrl);
    }
  }
}

const limit = maxPages > 0 ? maxPages : Infinity;
let crawled = 0;
const concurrency = Math.min(Math.max(1, maxConcurrency), 10);
log.info(`Auditing ${start.href} (max ${maxPages || 'unlimited'} pages, depth ${maxDepth}, concurrency ${concurrency}).`);

while (queue.length && crawled < limit) {
  const batch = queue.splice(0, Math.min(concurrency, limit - crawled));
  crawled += batch.length;
  await Promise.all(batch.map((item) => crawlOne(item)));
  if (crawled % 50 < concurrency) log.info(`Crawled ${crawled} page(s), ${queue.length} in queue.`);
}
const truncated = queue.length > 0;

// ---------- external link checks (optional) ----------

let externalChecked = 0;
if (checkExternalLinks) {
  const externals = [...inbound.keys()].filter((u) => !isInternal(new URL(u)) && !statusByUrl.has(u)).slice(0, maxExternalLinks);
  for (let i = 0; i < externals.length; i += concurrency) {
    await Promise.all(externals.slice(i, i + concurrency).map(async (u) => {
      if (respectRobotsTxt && !(await isAllowed(u))) return;
      try {
        let r = await fetchPage(u, { method: 'HEAD', timeoutMs: 15000 });
        if (r.status === 405 || r.status === 403) r = await fetchPage(u, { method: 'GET', timeoutMs: 15000 });
        statusByUrl.set(u, r.status);
      } catch {
        statusByUrl.set(u, 0);
      }
      externalChecked++;
    }));
  }
}

// ---------- issues per page ----------

const titleCount = new Map();
const descCount = new Map();
for (const p of pages.values()) {
  if (p.title) titleCount.set(p.title, (titleCount.get(p.title) || 0) + 1);
  if (p.metaDescription) descCount.set(p.metaDescription, (descCount.get(p.metaDescription) || 0) + 1);
}
const isBroken = (s) => s === 0 || s >= 400;
// External sites often answer 401/403/429/999 to bots although the link works for people: only clear failures count.
const isBrokenExternal = (s) => s === 0 || s === 404 || s === 410 || s >= 500;

const results = [];
for (const p of pages.values()) {
  const issues = [];
  const add = (code, details) => issues.push({ code, severity: ISSUE_TEXT[code][0], message: ISSUE_TEXT[code][1], ...(details ? { details } : {}) });
  if (p.status >= 500 || p.status === 0) add('HTTP_5XX', p.error || `HTTP ${p.status}`);
  else if (p.status >= 400) add('HTTP_4XX', `HTTP ${p.status}`);
  if ((p.redirectChain || []).length > 1) add('REDIRECT_CHAIN', `${p.redirectChain.length} redirects`);

  const isHtmlPage = p.title !== undefined;
  if (isHtmlPage && p.status < 400) {
    if (!p.title) add('MISSING_TITLE');
    else if (p.titleLength < titleMin) add('TITLE_TOO_SHORT', `${p.titleLength} characters`);
    else if (p.titleLength > titleMax) add('TITLE_TOO_LONG', `${p.titleLength} characters`);
    if (p.title && titleCount.get(p.title) > 1) add('DUPLICATE_TITLE', `${titleCount.get(p.title)} pages`);
    if (!p.metaDescription) add('MISSING_DESCRIPTION');
    else if (p.metaDescriptionLength < descriptionMin) add('DESCRIPTION_TOO_SHORT', `${p.metaDescriptionLength} characters`);
    else if (p.metaDescriptionLength > descriptionMax) add('DESCRIPTION_TOO_LONG', `${p.metaDescriptionLength} characters`);
    if (p.metaDescription && descCount.get(p.metaDescription) > 1) add('DUPLICATE_DESCRIPTION', `${descCount.get(p.metaDescription)} pages`);
    if (!p.h1.length) add('MISSING_H1');
    else if (p.h1.length > 1) add('MULTIPLE_H1', `${p.h1.length} h1 tags`);
    if (/noindex/.test(p.robotsMeta || '') || /noindex/i.test(p.xRobotsTag || '')) add('NOINDEX');
    if (!p.canonical) add('MISSING_CANONICAL');
    else if (p.canonical.replace(/\/$/, '') !== p.finalUrl.replace(/\/$/, '')) add('CANONICAL_TO_OTHER_PAGE', p.canonical);
    if (!p.lang) add('MISSING_LANG');
    if (!p.hasViewport) add('MISSING_VIEWPORT');
    if (p.imagesMissingAlt) add('IMAGES_MISSING_ALT', `${p.imagesMissingAlt} of ${p.imagesTotal} images`);
    if (p.mixedContent) add('MIXED_CONTENT', `${p.mixedContent} resources`);
    if (!p.finalUrl.startsWith('https:')) add('NOT_HTTPS');
    if (p.wordCount < 200) add('THIN_CONTENT', `${p.wordCount} words`);
    if (!p.ogTitle && !p.ogImage) add('MISSING_OPEN_GRAPH');
    if (!p.structuredDataTypes.length) add('NO_STRUCTURED_DATA');
    const brokenInternal = p.links.filter((l) => isInternal(new URL(l.url)) && statusByUrl.has(l.url) && isBroken(statusByUrl.get(l.url))).map((l) => ({ url: l.url, status: statusByUrl.get(l.url) }));
    const brokenExternal = p.links.filter((l) => !isInternal(new URL(l.url)) && statusByUrl.has(l.url) && isBrokenExternal(statusByUrl.get(l.url))).map((l) => ({ url: l.url, status: statusByUrl.get(l.url) }));
    if (brokenInternal.length) add('BROKEN_INTERNAL_LINKS', brokenInternal.slice(0, 50));
    if (brokenExternal.length) add('BROKEN_EXTERNAL_LINKS', brokenExternal.slice(0, 50));
  }
  if (p.responseTimeMs > slowPageMs) add('SLOW_RESPONSE', `${p.responseTimeMs} ms`);

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + SEVERITY_WEIGHT[i.severity], 0));
  const { links, ...rest } = p;
  results.push({
    ...rest,
    internalLinks: links ? links.filter((l) => isInternal(new URL(l.url))).length : null,
    externalLinks: links ? links.filter((l) => !isInternal(new URL(l.url))).length : null,
    inboundInternalLinks: inbound.get(p.url)?.size || 0,
    score,
    issueCount: issues.length,
    issues,
    auditedAt: new Date().toISOString(),
  });
}

// ---------- output ----------

results.sort((a, b) => a.score - b.score);
let saved = 0;
for (const row of results) {
  const res = await Actor.pushData(row);
  saved++;
  if (res?.eventChargeLimitReached) {
    budgetReached = true;
    log.warning('The maximum cost per run was reached. Remaining pages were audited but not saved.');
    break;
  }
}

const issueTotals = {};
for (const r of results) for (const i of r.issues) {
  issueTotals[i.code] ??= { code: i.code, severity: i.severity, message: i.message, pages: 0 };
  issueTotals[i.code].pages++;
}
const rootRobots = await getRobots(start.origin);
const summary = {
  site: start.href,
  pagesAudited: results.length,
  pagesSaved: saved,
  truncatedAtMaxPages: truncated,
  budgetReached,
  averageScore: results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : null,
  statusCodes: results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}),
  robotsTxtFound: rootRobots.found,
  sitemapsInRobotsTxt: rootRobots.sitemaps,
  pagesSkippedByRobotsTxt: skippedByRobots.length,
  externalLinksChecked: externalChecked,
  issues: Object.values(issueTotals).sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.pages - a.pages),
  worstPages: results.slice(0, 10).map((r) => ({ url: r.url, score: r.score, issueCount: r.issueCount })),
  generatedAt: new Date().toISOString(),
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sevColor = { error: '#dc2626', warning: '#d97706', notice: '#2563eb' };
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SEO audit: ${esc(start.hostname)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#111}h1{margin-bottom:.2rem}.muted{color:#666}.cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1.5rem 0}.card{border:1px solid #ddd;border-radius:8px;padding:1rem 1.25rem;min-width:140px}.card b{display:block;font-size:1.8rem}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border-bottom:1px solid #eee;padding:.45rem;text-align:left;font-size:.92rem}.sev{font-weight:600;text-transform:uppercase;font-size:.75rem}</style></head><body>
<h1>SEO audit: ${esc(start.hostname)}</h1><p class="muted">${esc(summary.generatedAt)} - ${summary.pagesAudited} pages${truncated ? ' (stopped at the page limit)' : ''}</p>
<div class="cards"><div class="card"><b>${summary.averageScore ?? '-'}</b>Average score</div><div class="card"><b>${summary.pagesAudited}</b>Pages audited</div><div class="card"><b>${summary.issues.filter((i) => i.severity === 'error').reduce((s, i) => s + i.pages, 0)}</b>Error findings</div><div class="card"><b>${summary.robotsTxtFound ? 'yes' : 'no'}</b>robots.txt</div></div>
<h2>Issues</h2><table><tr><th>Severity</th><th>Issue</th><th>Pages</th></tr>${summary.issues.map((i) => `<tr><td class="sev" style="color:${sevColor[i.severity]}">${i.severity}</td><td>${esc(i.message)} <span class="muted">(${i.code})</span></td><td>${i.pages}</td></tr>`).join('')}</table>
<h2>Pages to fix first</h2><table><tr><th>Score</th><th>URL</th><th>Issues</th></tr>${summary.worstPages.map((p) => `<tr><td>${p.score}</td><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td>${p.issueCount}</td></tr>`).join('')}</table>
<p class="muted">Generated by SEO Audit Crawler on Apify. Full per-page data is in the run's dataset.</p></body></html>`;

try {
  await Actor.setValue('SUMMARY', summary);
  await Actor.setValue('REPORT', html, { contentType: 'text/html; charset=utf-8' });
} catch (err) {
  log.warning(`Could not save SUMMARY/REPORT (${err.message}).`);
}
log.info(`Summary: ${JSON.stringify({ ...summary, issues: summary.issues.map((i) => `${i.code}:${i.pages}`) }).slice(0, 2500)}`);

if (!results.length) {
  await Actor.fail(skippedByRobots.length ? 'The start URL is disallowed by robots.txt.' : 'No page could be audited. Check the start URL.');
}
await Actor.exit(`Audited ${results.length} page(s), average score ${summary.averageScore}.`);

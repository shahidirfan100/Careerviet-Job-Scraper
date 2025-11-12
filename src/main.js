// CareerViet jobs scraper — fast & stealthy — EN + VI
// Works with deps you listed: apify ^3.4.5, crawlee ^3.14.1, cheerio ^1.0.0-rc.12, header-generator ^2.1.27

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Version-safe import (v2 default export)
import * as HG from 'header-generator';
const HeaderGeneratorClass = HG.HeaderGenerator || HG.default;

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toAbs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

const cleanText = (html) => {
  if (!html) return '';
  const $ = cheerioLoad(html);
  $('script, style, noscript, iframe, .hidden, [style*="display:none"]').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
};

// A single, very permissive matcher for EN + VI + legacy detail pages.
//  EN current: /en/search-job/<slug>.<A-Za-z0-9>.html
//  VI:         /vi/tim-viec-lam/<slug>.<digits>.html
//  Legacy EN:  /jobs/<slug>-<digits>.html
const JOB_DETAIL_RE =
  /careerviet\.vn\/(?:(?:en\/search-job\/[^/?#]+\.[A-Za-z0-9]+\.html)|(?:vi\/tim-viec-lam\/[^/?#]+\.\d+\.html)|(?:jobs\/[^/?#]+-\d+\.html))/i;

function extractFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html() || '';
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of arr) {
        const t = node && (node['@type'] || node.type);
        const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
        if (isJob) {
          return {
            title: node.title || node.name || null,
            company: node.hiringOrganization?.name || null,
            date_posted: node.datePosted || null,
            description_html: node.description || null,
            location: node.jobLocation?.address?.addressLocality || node.jobLocation?.address?.addressRegion || null,
            salary: node.baseSalary?.value || null,
            job_type: node.employmentType || null,
          };
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  return null;
}

function findJobLinks($, base, dedupeSet) {
  const out = new Set();

  // 1) Broad scan across all anchors
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;
    const abs = toAbs(href, base);
    if (abs && JOB_DETAIL_RE.test(abs)) out.add(abs);
  });

  // 2) Fallback: scan common “card/title” blocks if 0 found
  if (out.size === 0) {
    $('h2 a[href], .job, .job-card, .job-item, [data-job-id]').find('a[href]').each((_, a) => {
      const href = ($(a).attr('href') || '').trim();
      const abs = toAbs(href, base);
      if (abs && JOB_DETAIL_RE.test(abs)) out.add(abs);
    });
  }

  const links = [...out];
  const deduped = links.filter((u) => !dedupeSet.has(u));
  for (const u of deduped) dedupeSet.add(u);
  return deduped;
}

// English pagination uses file pattern ...-page-N-en.html; the pager is also numeric (2, 3, 4...).
function findNextPage($, base, currentPage) {
  // 1) rel="next"
  let href = $('a[rel="next"]').attr('href') || null;

  // 2) "Next"/"Tiếp"
  if (!href) {
    href = $('a:contains("Next"), a:contains("Tiếp"), a[aria-label*="Next"]')
      .filter((_, el) => $(el).text().trim().toLowerCase().includes('next') || $(el).text().trim().toLowerCase().includes('tiếp'))
      .first().attr('href') || null;
  }

  // 3) EN page files: ...-page-(N)-en.html
  if (!href) {
    const nextNum = currentPage + 1;
    href = $(`a[href*="-page-${nextNum}-en.html"]`).first().attr('href') || null;
  }

  // 4) Numeric anchor pointing to another page file
  if (!href) {
    const nextNum = currentPage + 1;
    const a = $(`a:contains("${nextNum}")`).filter((_, el) => $(el).text().trim() === String(nextNum)).first();
    href = a.attr('href') || null;
  }

  // 5) VN style: trang-N-vi.html
  if (!href) {
    const nextNum = currentPage + 1;
    href = $(`a[href*="trang-${nextNum}-vi.html"]`).first().attr('href') || null;
  }

  if (!href) return null;
  const abs = toAbs(href, base);
  if (abs) log.debug(`Pagination -> ${abs}`);
  return abs;
}

// ---------- Header generator (desktop profiles, EN + VI) ----------
const headerGenerator = new HeaderGeneratorClass({
  browsers: [{ name: 'chrome', minVersion: 120 }, { name: 'firefox', minVersion: 115 }, { name: 'safari', minVersion: 16 }],
  devices: ['desktop'],
  operatingSystems: ['windows', 'macos'],
  locales: ['en-US', 'vi-VN'],
});

// ---------- Main ----------
await Actor.init();

try {
  const input = (await Actor.getInput()) || {};

  // Accept multiple aliases for “how many to fetch”
  const aliasNumbers = [
    input.results_wanted, input.jobs, input.max_items, input.maxItems, input.maxResults, input.limit,
  ].map((v) => (v == null ? undefined : +v));
  const firstNum = aliasNumbers.find((v) => Number.isFinite(v));
  const RESULTS_WANTED = firstNum ? Math.max(1, firstNum) : 10;

  const {
    keyword = '',
    location = '',
    max_age_days,

    max_pages: MAX_PAGES_RAW = 25,
    collectDetails = true,
    dedupe = true,

    // speed/stealth
    maxConcurrency = 10,
    listDelayMsMin = 150, listDelayMsMax = 600,
    detailDelayMsMin = 200, detailDelayMsMax = 700,

    startUrl, startUrls, url,
    proxyConfiguration,
  } = input;

  const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 25;

  function buildStartUrl(kw, loc) {
    const englishAll = 'https://careerviet.vn/jobs/all-jobs-en.html'; // verified list page
    if (!kw && !loc) return englishAll;

    // If filters are requested, VN listing provides query params
    const base = 'https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam';
    const params = new URLSearchParams();
    if (kw) params.set('keyword', kw);
    if (loc) params.set('location', loc);
    if (max_age_days) {
      const ageMap = { 1: '24h', 7: '7d', 30: '30d' };
      const v = ageMap[max_age_days];
      if (v) params.set('posted', v);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : englishAll;
  }

  const initial = [];
  if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
  if (startUrl) initial.push(startUrl);
  if (url) initial.push(url);
  if (!initial.length) initial.push(buildStartUrl(keyword, location));

  const proxyConf = proxyConfiguration
    ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
    : undefined;

  let saved = 0;
  const seen = new Set();

  const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConf,
    useSessionPool: true,
    maxRequestRetries: 3,
    maxConcurrency,
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 45,

    preNavigationHooks: [
      async (ctx) => {
        const headers = headerGenerator.getHeaders();
        ctx.request.headers = { ...ctx.request.headers, ...headers };
        ctx.request.headers.referer =
          ctx.request.userData?.label === 'DETAIL'
            ? 'https://careerviet.vn/jobs/all-jobs-en.html'
            : 'https://careerviet.vn/';
        // Short, randomized cadence — fast but humane
        const jitter = ctx.request.userData?.label === 'DETAIL'
          ? detailDelayMsMin + Math.floor(Math.random() * (detailDelayMsMax - detailDelayMsMin + 1))
          : listDelayMsMin + Math.floor(Math.random() * (listDelayMsMax - listDelayMsMin + 1));
        await sleep(jitter);
      },
    ],

    async requestHandler({ request, $, enqueueLinks, session, log: clog }) {
      const label = request.userData?.label || 'LIST';
      const pageNo = request.userData?.pageNo || 1;

      if (label === 'LIST') {
        const links = findJobLinks($, request.url, seen);
        const remaining = RESULTS_WANTED - saved;
        const toTake = Math.max(0, Math.min(remaining, links.length));

        clog.info(`LIST p${pageNo}: found ${links.length} detail links | taking ${toTake} (saved=${saved}/${RESULTS_WANTED})`);

        if (collectDetails && toTake > 0) {
          await enqueueLinks({
            urls: links.slice(0, toTake),
            userData: { label: 'DETAIL' },
            forefront: false,
          });
        } else if (!collectDetails && toTake > 0) {
          const toPush = links.slice(0, toTake).map((u) => ({ url: u, _source: 'careerviet.vn' }));
          await Dataset.pushData(toPush);
          saved += toPush.length;
          clog.info(`LIST p${pageNo}: pushed ${toPush.length} link-only items (saved=${saved})`);
        }

        if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
          const next = findNextPage($, request.url, pageNo);
          if (next) {
            await enqueueLinks({
              urls: [next],
              userData: { label: 'LIST', pageNo: pageNo + 1 },
              forefront: false,
            });
          } else {
            clog.info(`LIST p${pageNo}: no next page detected`);
          }
        }
        return;
      }

      if (label === 'DETAIL') {
        if (saved >= RESULTS_WANTED) return;

        try {
          const json = extractFromJsonLd($) || {};
          const data = { ...json };

          // Robust fallbacks (EN + VI)
          if (!data.title) {
            data.title =
              $('h1.job-title, .job-title h1, .title h1, h1').first().text().trim() ||
              $('[class*="job-title"]').first().text().trim() || null;
          }
          if (!data.company) {
            data.company =
              $('.company-name, .employer-name, [class*="company"], a[href*="/company/"], a[href*="nha-tuyen-dung"]')
                .first().text().trim() || null;
          }
          if (!data.location) {
            data.location =
              $('[class*="location"], [class*="address"], .location span').first().text().trim() ||
              $('li:contains("Location")').next().text().trim() || null;
          }
          if (!data.salary) {
            data.salary =
              $('[class*="salary"], .salary, [class*="luong"]').first().text().trim() ||
              $('li:contains("Salary")').next().text().trim() || null;
          }
          if (!data.job_type) {
            data.job_type =
              $('[class*="job-type"], [class*="employment"]').first().text().trim() ||
              $('li:contains("Job type")').next().text().trim() || null;
          }
          if (!data.date_posted) {
            const dt =
              $('time[datetime]').first().attr('datetime') ||
              $('[class*="date"], [class*="posted"], time').first().text().trim() ||
              $('li:contains("Updated")').next().text().trim() || null;
            data.date_posted = dt || null;
          }
          if (!data.description_html) {
            const descSel = ['.job-description', '.description', '[class*="description"]', '.content', '[class*="content"]', '.entry-content'];
            for (const s of descSel) {
              const el = $(s).first();
              if (el.length && (el.html() || '').trim()) { data.description_html = el.html().trim(); break; }
            }
          }
          data.description_text = data.description_html ? cleanText(data.description_html) : null;

          // Optional age filter
          if (max_age_days && data.date_posted) {
            const posted = new Date(data.date_posted);
            if (!Number.isNaN(+posted)) {
              const ageDays = (Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24);
              if (ageDays > +max_age_days) {
                clog.info(`Skip old job (${ageDays.toFixed(1)}d): ${data.title || request.url}`);
                return;
              }
            }
          }

          const item = {
            title: data.title || null,
            company: data.company || null,
            location: data.location || null,
            salary: data.salary || null,
            job_type: data.job_type || null,
            date_posted: data.date_posted || null,
            description_html: data.description_html || null,
            description_text: data.description_text || null,
            url: request.url,
            _source: 'careerviet.vn',
          };

          await Dataset.pushData(item);
          saved++;
          clog.info(`DETAIL saved ${saved}/${RESULTS_WANTED}: ${item.title || request.url}`);
        } catch (err) {
          clog.error(`DETAIL error ${request.url}: ${err?.message || err}`);
          if (/403|429|forbidden|blocked|captcha/i.test(String(err?.message || ''))) session?.retire();
        }
      }
    },

    failedRequestHandler({ request, log: clog, session }) {
      clog.error(`FAILED ${request.url} after retries`);
      session?.retire();
    },
  });

  log.info(`Start: ${initial[0]} | target=${RESULTS_WANTED} | maxPages=${MAX_PAGES} | concurrency=${maxConcurrency}`);
  await crawler.run(initial.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
  log.info(`Finished. Saved ${saved} job(s).`);
} catch (e) {
  log.exception(e, 'Actor failed');
  process.exitCode = 1;
} finally {
  await Actor.exit();
}

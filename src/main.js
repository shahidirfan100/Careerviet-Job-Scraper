// CareerViet jobs scraper — fast, stealthy, and CLEAN meta fields (EN + VI)
// Works with: apify ^3.4.5, crawlee ^3.14.1, cheerio ^1.0.0-rc.12, header-generator ^2.1.27

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Version-safe import (v2 default export for header-generator)
import * as HG from 'header-generator';
const HeaderGeneratorClass = HG.HeaderGenerator || HG.default;

// ---------- Small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toAbs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };
const text = ($el) => ($el?.text?.() || '').replace(/\s+/g, ' ').trim();
const html = ($el) => ($el?.html?.() || '').trim() || '';

const cleanText = (rawHtml) => {
  if (!rawHtml) return '';
  const $ = cheerioLoad(rawHtml);
  $('script, style, noscript, iframe').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
};

// EN + VI + legacy job detail URL patterns
const JOB_DETAIL_RE =
  /careerviet\.vn\/(?:(?:en\/search-job\/[^/?#]+\.[A-Za-z0-9]+\.html)|(?:vi\/tim-viec-lam\/[^/?#]+\.\d+\.html)|(?:jobs\/[^/?#]+-\d+\.html))/i;

// ---------- Safe coercers & normalizers ----------
const toStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => toStr(x)).filter(Boolean).join(' | ');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// JSON-LD salary -> compact human string
function coerceSalary(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim();

  try {
    const v = value.value && typeof value.value === 'object' ? value.value : value;
    const cur = value.currency || v.currency || '';
    const min = v.minValue ?? v.value ?? v.min ?? null;
    const max = v.maxValue ?? v.max ?? null;
    const unit = v.unitText || v.unit || '';

    const moneyFmt = (num) => (num == null ? null : String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    const curSym = /vnd|₫/i.test(cur) ? '₫' : (/usd|\$/i.test(cur) ? '$' : (cur || ''));

    if (min != null && max != null) {
      return `${curSym ? curSym + ' ' : ''}${moneyFmt(min)} - ${curSym ? curSym + ' ' : ''}${moneyFmt(max)}${unit ? ` / ${unit}` : ''}`.trim();
    }
    if (min != null) {
      return `${curSym ? curSym + ' ' : ''}${moneyFmt(min)}${unit ? ` / ${unit}` : ''}`.trim();
    }
    return toStr(value);
  } catch {
    return toStr(value);
  }
}

function normalizeJobType(s) {
  const raw = toStr(s).trim();
  if (!raw) return null;
  const v = raw.toLowerCase();

  // EN
  if (/full[\s-]?time|permanent/.test(v)) return 'Full-time';
  if (/part[\s-]?time/.test(v)) return 'Part-time';
  if (/intern|internship/.test(v)) return 'Internship';
  if (/contract|fixed[-\s]?term/.test(v)) return 'Contract';
  if (/temporary|temp/.test(v)) return 'Temporary';
  if (/freelance|self[-\s]?employed/.test(v)) return 'Freelance';
  if (/\bremote\b/.test(v)) return 'Remote';
  if (/\bhybrid\b/.test(v)) return 'Hybrid';

  // VI
  if (/toàn\s*thời\s*gian/.test(v)) return 'Full-time';
  if (/bán\s*thời\s*gian/.test(v)) return 'Part-time';
  if (/thực\s*tập/.test(v)) return 'Internship';
  if (/hợp\s*đồng/.test(v)) return 'Contract';
  if (/tạm\s*thời/.test(v)) return 'Temporary';
  if (/tự\s*do/.test(v)) return 'Freelance';
  if (/từ\s*xa/.test(v)) return 'Remote';
  if (/lai/.test(v)) return 'Hybrid';

  // Avoid category dumps
  if (raw.length > 120 || /jobs?\b/i.test(raw)) return null;
  return raw;
}

function normalizeLocation(s) {
  const raw = toStr(s).trim();
  if (!raw) return null;
  if (raw.length > 120 || /jobs?\b/i.test(raw)) return null;

  const cleaned = raw.replace(/(View map|Bản đồ)/i, '').replace(/\s{2,}/g, ' ').trim();
  const parts = cleaned.split(/[|,•/]+/).map((p) => p.trim()).filter(Boolean);
  return parts[0] || cleaned || null;
}

function normalizeSalary(s) {
  // Try JSON-LD object formatting first
  const asStr = coerceSalary(s);
  if (!asStr) return null;

  const raw = toStr(asStr).replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  if (/negotiable|thoả thuận|thỏa thuận/i.test(raw)) return 'Negotiable';

  const money = raw.match(/(\$|USD|₫|VND)\s?[\d.,]+(?:\s*[-–]\s*(\$|USD|₫|VND)?\s?[\d.,]+)?/i);
  if (money) {
    const period = raw.match(/per\s+(hour|month|year)|\/\s*(hour|month|year)|\/\s*(giờ|tháng|năm)/i);
    return money[0] + (period ? ` / ${period[1] || period[2] || period[3]}` : '');
  }

  const rangeNums = raw.match(/[\d.,]+\s*[-–]\s*[\d.,]+/);
  if (rangeNums) return rangeNums[0];

  const singleMoney = raw.match(/(\$|USD|₫|VND)\s?[\d.,]+/i);
  if (singleMoney) return singleMoney[0];

  if (raw.length > 120 || /jobs?\b/i.test(raw)) return null;
  return raw;
}

// ---------- Label-based meta extractor (scoped to meta blocks) ----------
function getMetaByLabel($, labelPatterns, roots) {
  delete getMetaByLabel._found;

  for (const rootSel of roots) {
    const root = $(rootSel).first();
    if (!root.length) continue;

    // 1) Definition lists
    root.find('dt, .dt, .label, .name').each((_, el) => {
      const t = text($(el));
      if (!t) return;
      for (const re of labelPatterns) {
        if (re.test(t)) {
          const val = text($(el).next('dd, .dd, .value'));
          if (val) return (getMetaByLabel._found = val);
        }
      }
    });
    if (getMetaByLabel._found) return getMetaByLabel._found;

    // 2) Tables
    root.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const key = text($tr.find('th, td').first());
      const val = text($tr.find('td').eq(1));
      if (!key || !val) return;
      for (const re of labelPatterns) if (re.test(key)) return (getMetaByLabel._found = val);
    });
    if (getMetaByLabel._found) return getMetaByLabel._found;

    // 3) Key:Value in lists/blocks
    root.find('li, .row, .item, .field').each((_, li) => {
      const $li = $(li);
      const key = text($li.find('strong, b, .label, .name, .title').first()) || text($li.children().first());
      const val = text($li.find('.value, .content, span, div').not('.label,.name,.title').last());
      if (!key || !val) return;
      for (const re of labelPatterns) if (re.test(key)) return (getMetaByLabel._found = val);
    });
    if (getMetaByLabel._found) return getMetaByLabel._found;

    // 4) Inline "Label: Value"
    root.find('*').each((_, el) => {
      const t = text($(el));
      if (!t) return;
      const m = t.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim();
        for (const re of labelPatterns) if (re.test(key)) return (getMetaByLabel._found = val);
      }
    });
    if (getMetaByLabel._found) return getMetaByLabel._found;
  }
  return null;
}

// ---------- JSON-LD extraction ----------
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
            salary: node.baseSalary ? coerceSalary(node.baseSalary) : null, // <- salary object friendly
            job_type: node.employmentType || null,
          };
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  return null;
}

// ---------- Link discovery & pagination ----------
function findJobLinks($, base, dedupeSet) {
  const out = new Set();
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;
    const abs = toAbs(href, base);
    if (abs && JOB_DETAIL_RE.test(abs)) out.add(abs);
  });
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

function findNextPage($, base, currentPage) {
  let href = $('a[rel="next"]').attr('href') || null;
  if (!href) {
    href = $('a:contains("Next"), a:contains("Tiếp"), a[aria-label*="Next"]')
      .filter((_, el) => /next|tiếp/i.test(text($(el)))).first().attr('href') || null;
  }
  if (!href) {
    const nextNum = currentPage + 1;
    href = $(`a[href*="-page-${nextNum}-en.html"]`).first().attr('href') || null;
  }
  if (!href) {
    const nextNum = currentPage + 1;
    const a = $(`a:contains("${nextNum}")`).filter((_, el) => text($(el)) === String(nextNum)).first();
    href = a.attr('href') || null;
  }
  if (!href) {
    const nextNum = currentPage + 1;
    href = $(`a[href*="trang-${nextNum}-vi.html"]`).first().attr('href') || null;
  }
  if (!href) return null;
  const abs = toAbs(href, base);
  if (abs) log.debug(`Pagination -> ${abs}`);
  return abs;
}

// ---------- Header generator ----------
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
    const englishAll = 'https://careerviet.vn/jobs/all-jobs-en.html';
    if (!kw && !loc) return englishAll;

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

  // Single declaration of `initial`
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
          // 1) JSON-LD first
          const json = extractFromJsonLd($) || {};
          const data = { ...json };

          // 2) Title/company fallbacks
          if (!data.title) {
            data.title =
              text($('h1.job-title, .job-title h1, .title h1, h1').first()) ||
              text($('[class*="job-title"]').first()) || null;
          }
          if (!data.company) {
            data.company =
              text($('.company-name, .employer-name, [class*="company"], a[href*="/company/"], a[href*="nha-tuyen-dung"]').first()) ||
              null;
          }

          // 3) Meta roots (avoid sidebars)
          const META_ROOTS = [
            '.job-summary', '.job-info', '.job-meta', '.job-details', '.box-info', '.box-summary',
            '.job-header', '.job-main', '.job-overview', '.job-brief', '.job-information',
            'article .summary', 'article .meta', '.content .meta',
          ].map((s) => `${s}:not(.sidebar):not(.aside)`);

          // Label regexes (EN + VI)
          const reLocation = [/^(location|work\s*location|địa\s*điểm|nơi\s*làm\s*việc|khu\s*vực)$/i];
          const reSalary   = [/^(salary|mức\s*lương|thu\s*nhập)$/i];
          const reType     = [/^(job\s*type|employment|loại\s*công\s*việc|hình\s*thức\s*làm\s*việc)$/i];

          // 4) Label-based extraction (tables, lists, dl)
          let metaLocation = getMetaByLabel($, reLocation, META_ROOTS);
          let metaSalary   = getMetaByLabel($, reSalary, META_ROOTS);
          let metaType     = getMetaByLabel($, reType, META_ROOTS);

          // 5) Tight CSS fallbacks scoped to meta blocks
          const scopedFind = (selectors) => {
            for (const rootSel of META_ROOTS) {
              const root = $(rootSel).first();
              if (!root.length) continue;
              for (const sel of selectors) {
                const v = text(root.find(sel).first());
                if (v) return v;
              }
            }
            return null;
          };

          if (!metaLocation) {
            metaLocation = scopedFind([
              '.location, [class*="location"] span, li.location span',
              'li:contains("Location") span, li:contains("Địa điểm") span',
              'td:contains("Location") + td, td:contains("Địa điểm") + td',
            ]);
          }
          if (!metaSalary) {
            metaSalary = scopedFind([
              '.salary, [class*="salary"] span, li.salary span',
              'li:contains("Salary") span, li:contains("Mức lương") span, li:contains("Thu nhập") span',
              'td:contains("Salary") + td, td:contains("Mức lương") + td, td:contains("Thu nhập") + td',
            ]);
          }
          if (!metaType) {
            metaType = scopedFind([
              '.employment, .job-type, [class*="employment"] span, [class*="job-type"] span',
              'li:contains("Job type") span, li:contains("Employment") span, li:contains("Hình thức") span, li:contains("Loại công việc") span',
              'td:contains("Job type") + td, td:contains("Employment") + td, td:contains("Hình thức") + td, td:contains("Loại công việc") + td',
            ]);
          }

          // 6) Coerce then normalize (handles arrays/objects safely)
          const rawLocation = metaLocation || data.location || null;
          const rawSalary   = metaSalary   || data.salary   || null;
          const rawType     = metaType     || data.job_type || null;

          data.location = normalizeLocation(rawLocation);
          data.salary   = normalizeSalary(rawSalary);
          data.job_type = normalizeJobType(rawType);

          // 7) Date posted fallback
          if (!data.date_posted) {
            const dt =
              $('time[datetime]').first().attr('datetime') ||
              text($('[class*="date"], [class*="posted"], time').first());
            data.date_posted = dt || null;
          }

          // 8) Description fallback
          if (!data.description_html) {
            const descSel = [
              '.job-description', '.description', '[class*="description"]',
              '.content', '[class*="content"]', '.entry-content', 'article .content',
            ];
            for (const s of descSel) {
              const el = $(s).first();
              const h = html(el);
              if (h) { data.description_html = h; break; }
            }
          }
          data.description_text = data.description_html ? cleanText(data.description_html) : null;

          // 9) Optional age filter
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

  // ---------- Boot ----------
  log.info(`Start: ${initial[0]} | target=${RESULTS_WANTED} | maxPages=${MAX_PAGES} | concurrency=${maxConcurrency}`);
  await crawler.run(initial.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
  log.info(`Finished. Saved ${saved} job(s).`);
} catch (e) {
  log.exception(e, 'Actor failed');
  process.exitCode = 1;
} finally {
  await Actor.exit();
}

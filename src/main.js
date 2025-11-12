// Production-ready jobs scraper (Careerviet.vn) — Node 22 + ESM
// Deps (per your package.json):
//  apify ^3.4.5, crawlee ^3.14.1, cheerio ^1.0.0-rc.12, header-generator ^2.1.27

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// --- Version-safe import for header-generator (v2 default export)
import * as HG from 'header-generator';
const HeaderGeneratorClass = HG.HeaderGenerator || HG.default;

// ---- Small helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toAbs = (href, base) => {
    try { return new URL(href, base).href; } catch { return null; }
};
const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe, .hidden, [style*="display:none"]').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

// ---- Header generator (desktop EN + VI)
const headerGenerator = new HeaderGeneratorClass({
    browsers: [
        { name: 'chrome', minVersion: 118 },
        { name: 'firefox', minVersion: 115 },
        { name: 'safari', minVersion: 16 },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'vi-VN'],
});

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};

    // --- Accept multiple aliases for "how many jobs"
    const resultsWantedAliases = [
        input.results_wanted,
        input.jobs,
        input.max_items,
        input.maxItems,
        input.maxResults,
        input.limit,
    ].map((v) => (v == null ? undefined : +v));
    const firstNumber = resultsWantedAliases.find((v) => Number.isFinite(v));
    const RESULTS_WANTED = firstNumber ? Math.max(1, firstNumber) : 10; // default 10 to match your schema intent

    const {
        keyword = '',
        location = '',
        max_age_days, // optional

        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true,
        dedupe = true,
        maxConcurrency = 5,

        startUrl,
        startUrls,
        url,

        proxyConfiguration,
    } = input;

    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

    // Build default listing URL if none provided (keeps VN path for backwards-compat)
    const buildStartUrl = (kw, loc) => {
        // Prefer the English all-jobs page if no filters given
        const englishAll = 'https://careerviet.vn/jobs/all-jobs-en.html';
        if (!kw && !loc) return englishAll;

        // Otherwise fall back to the VN filterable listing
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
    };

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

    function extractFromJsonLd($) {
        const scripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < scripts.length; i++) {
            try {
                const raw = $(scripts[i]).html() || '';
                const parsed = JSON.parse(raw);
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                for (const node of arr) {
                    if (!node) continue;
                    const t = node['@type'] || node.type;
                    const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                    if (isJob) {
                        return {
                            title: node.title || node.name || null,
                            company: node.hiringOrganization?.name || null,
                            date_posted: node.datePosted || null,
                            description_html: node.description || null,
                            location:
                                node.jobLocation?.address?.addressLocality ||
                                node.jobLocation?.address?.addressRegion || null,
                            salary: node.baseSalary?.value || null,
                            job_type: node.employmentType || null,
                        };
                    }
                }
            } catch {
                // ignore malformed json-ld
            }
        }
        return null;
    }

    // --- BROAD matcher: support both EN and VI job detail URLs
    // Examples:
    //  https://careerviet.vn/jobs/some-job-title-12345.html
    //  https://careerviet.vn/vi/tim-viec-lam/some-title.12345.html
    const JOB_DETAIL_RE = /careerviet\.vn\/(?:jobs\/[^/?#]+-\d+\.html|vi\/tim-viec-lam\/[^/?#]+\.\d+\.html)/i;

    function findJobLinks($, base) {
        const links = new Set();
        $('a[href]').each((_, a) => {
            const href = ($(a).attr('href') || '').trim();
            if (!href) return;
            const abs = toAbs(href, base);
            if (!abs) return;
            if (JOB_DETAIL_RE.test(abs)) {
                if (!dedupe || !seen.has(abs)) {
                    links.add(abs);
                    if (dedupe) seen.add(abs);
                }
            }
        });

        // Fallback: many sites keep job links inside card blocks; try obvious selectors
        if (links.size === 0) {
            $('.job, .job-card, .job-item, [data-job-id]').find('a[href]').each((_, a) => {
                const href = ($(a).attr('href') || '').trim();
                const abs = toAbs(href, base);
                if (abs && JOB_DETAIL_RE.test(abs) && (!dedupe || !seen.has(abs))) {
                    links.add(abs);
                    if (dedupe) seen.add(abs);
                }
            });
        }
        return [...links];
    }

    function findNextPage($, base, currentPage) {
        // 1) Look for explicit rel=next
        let href = $('a[rel="next"]').attr('href') || null;

        // 2) Common "Next" labels (EN and VI)
        if (!href) {
            href = $('a:contains("Next"), a:contains("Tiếp"), a[aria-label*="Next"]')
                .filter((_, el) => $(el).text().trim().toLowerCase().includes('next') ||
                                   $(el).text().trim().toLowerCase().includes('tiếp'))
                .first()
                .attr('href') || null;
        }

        // 3) Query param page=2 style (English listing)
        if (!href) {
            const nextNum = currentPage + 1;
            href = $(`a[href*="page=${nextNum}"]`).first().attr('href') || null;
        }

        // 4) VN style "trang-2-vi.html"
        if (!href) {
            const nextNum = currentPage + 1;
            href = $(`a[href*="trang-${nextNum}-vi.html"]`).first().attr('href') || null;
        }

        if (!href) return null;
        const abs = toAbs(href, base);
        if (abs) log.debug(`Pagination: next page resolved -> ${abs}`);
        return abs;
    }

    const crawler = new CheerioCrawler({
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        useSessionPool: true,
        maxConcurrency,
        proxyConfiguration: proxyConf,

        preNavigationHooks: [
            async (ctx) => {
                const headers = headerGenerator.getHeaders();
                ctx.request.headers = { ...ctx.request.headers, ...headers };
                ctx.request.headers.referer =
                    ctx.request.userData?.label === 'DETAIL'
                        ? 'https://careerviet.vn/jobs/all-jobs-en.html'
                        : 'https://careerviet.vn/';
                await sleep(700 + Math.floor(Math.random() * 1600));
            },
        ],

        async requestHandler({ request, $, enqueueLinks, session, log: clog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            await sleep(500 + Math.floor(Math.random() * 1200));

            if (label === 'LIST') {
                const links = findJobLinks($, request.url);
                clog.info(`LIST p${pageNo}: found ${links.length} candidate job links`);

                if (collectDetails) {
                    const remaining = RESULTS_WANTED - saved;
                    if (remaining > 0) {
                        const slice = links.slice(0, remaining);
                        clog.debug(`Enqueueing ${slice.length} detail URLs (remaining target: ${remaining})`);
                        await enqueueLinks({
                            urls: slice,
                            userData: { label: 'DETAIL' },
                            forefront: false,
                        });
                    }
                } else {
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = links.slice(0, remaining).map((u) => ({
                        url: u,
                        title: null,
                        company: null,
                        location: null,
                        _source: 'careerviet.vn',
                    }));
                    if (toPush.length) {
                        await Dataset.pushData(toPush);
                        saved += toPush.length;
                    }
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
                        clog.info(`No next page link detected on p${pageNo}.`);
                    }
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) return;

                try {
                    const json = extractFromJsonLd($) || {};
                    const data = { ...json };

                    if (!data.title) {
                        data.title =
                            $('h1.job-title, .job-title h1, .title h1, h1').first().text().trim() ||
                            $('[class*="job-title"]').first().text().trim() || null;
                    }
                    if (!data.company) {
                        data.company =
                            $('.company-name, .employer-name, [class*="company"], a[href*="nha-tuyen-dung"], a[href*="/employer/"]')
                                .first().text().trim() || null;
                    }
                    if (!data.location) {
                        data.location =
                            $('[class*="location"], [class*="address"], .location span').first().text().trim() || null;
                    }
                    if (!data.salary) {
                        data.salary =
                            $('[class*="salary"], .salary, [class*="luong"]').first().text().trim() || null;
                    }
                    if (!data.job_type) {
                        data.job_type =
                            $('[class*="job-type"], [class*="employment"]').first().text().trim() || null;
                    }
                    if (!data.date_posted) {
                        const dt =
                            $('time[datetime]').first().attr('datetime') ||
                            $('[class*="date"], [class*="posted"], time').first().text().trim() ||
                            null;
                        data.date_posted = dt || null;
                    }
                    if (!data.description_html) {
                        const descSel = [
                            '.job-description',
                            '.description',
                            '[class*="description"]',
                            '.content',
                            '[class*="content"]',
                            '.entry-content',
                        ];
                        for (const s of descSel) {
                            const el = $(s).first();
                            if (el.length && (el.html() || '').trim()) {
                                data.description_html = el.html().trim();
                                break;
                            }
                        }
                    }
                    data.description_text = data.description_html ? cleanText(data.description_html) : null;

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
                    clog.info(`Saved ${saved}/${RESULTS_WANTED}: ${item.title || request.url}`);
                } catch (err) {
                    clog.error(`DETAIL error ${request.url}: ${err?.message || err}`);
                    if (/403|429|forbidden|blocked/i.test(String(err?.message || ''))) {
                        session?.retire();
                    }
                }
            }
        },

        failedRequestHandler({ request, log: clog, session }) {
            clog.error(`FAILED ${request.url} after retries`);
            session?.retire();
        },
    });

    log.info(
        `Start: ${initial.length} start URL(s). Target: ${RESULTS_WANTED} jobs. Max pages: ${MAX_PAGES}. Concurrency: ${maxConcurrency}.`,
    );

    await crawler.run(
        initial.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })),
    );

    log.info(`Finished. Saved ${saved} job(s).`);
} catch (e) {
    log.exception(e, 'Actor failed');
    process.exitCode = 1;
} finally {
    await Actor.exit();
}

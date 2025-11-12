// Production-ready jobs scraper (Careerviet.vn example) — Node 22 + ESM
// Works with deps:
//  apify ^3.4.5, crawlee ^3.14.1, cheerio ^1.0.0-rc.12, header-generator ^2.1.27

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// --- FIX: Version-safe import for header-generator (v2 exports default)
//     Avoids: "does not provide an export named 'createHeaderGenerator'"
import * as HG from 'header-generator';
const HeaderGeneratorClass = HG.HeaderGenerator || HG.default;

// ---- Utility helpers
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

// ---- Configure a realistic header generator (desktop mix, EN + VI)
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
    const {
        // search params
        keyword = '',
        location = '',
        max_age_days, // optional: 1 | 7 | 30

        // crawling controls
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true,
        dedupe = true,
        maxConcurrency = 5,

        // entry URLs
        startUrl,
        startUrls,
        url,

        // proxy config passed through input (Apify proxy recommended)
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

    // ---- Build default listing URL for careerviet.vn if none provided
    const buildStartUrl = (kw, loc) => {
        const base = 'https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam';
        const params = new URLSearchParams();
        if (kw) params.set('keyword', kw);
        if (loc) params.set('location', loc);
        if (max_age_days) {
            // Map days to site's UI when available
            const ageMap = { 1: '24h', 7: '7d', 30: '30d' };
            const v = ageMap[max_age_days];
            if (v) params.set('posted', v);
        }
        const qs = params.toString();
        return qs ? `${base}?${qs}` : base;
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

    function findJobLinks($, base) {
        const links = new Set();
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href');
            if (!href) return;
            // careerviet detail pattern
            if (/careerviet\.vn\/vi\/tim-viec-lam\/[^\/]+\.?\d*\.html/i.test(href)) {
                const abs = toAbs(href, base);
                if (abs && (!dedupe || !seen.has(abs))) {
                    links.add(abs);
                    if (dedupe) seen.add(abs);
                }
            }
        });
        return [...links];
    }

    function findNextPage($, base, currentPage) {
        // Try numbered pagination
        const nextPage = currentPage + 1;
        let href =
            $(`a[href*="page=${nextPage}"], a[href*="trang-${nextPage}-vi.html"], a:contains("${nextPage}")`)
                .first()
                .attr('href') || null;

        if (!href) {
            // Fallback: next/tiếp
            href = $('a[rel="next"], a:contains("Next"), a:contains("Tiếp")').first().attr('href') || null;
        }
        return href ? toAbs(href, base) : null;
    }

    const crawler = new CheerioCrawler({
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        useSessionPool: true,
        maxConcurrency,
        proxyConfiguration: proxyConf,

        // Stealth headers + cadence jitter
        preNavigationHooks: [
            async (ctx) => {
                const headers = headerGenerator.getHeaders();
                ctx.request.headers = { ...ctx.request.headers, ...headers };
                if (ctx.request.userData?.label === 'LIST') {
                    ctx.request.headers.referer = 'https://careerviet.vn/vi/';
                } else if (ctx.request.userData?.label === 'DETAIL') {
                    ctx.request.headers.referer = 'https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam';
                }
                // small random delay before nav
                await sleep(800 + Math.floor(Math.random() * 1700));
            },
        ],

        async requestHandler({ request, $, enqueueLinks, session, log: clog }) {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            // vary cadence a bit per request
            await sleep(600 + Math.floor(Math.random() * 1500));

            if (label === 'LIST') {
                const links = findJobLinks($, request.url);
                clog.info(`LIST p${pageNo}: found ${links.length} jobs`);

                if (collectDetails) {
                    const remaining = RESULTS_WANTED - saved;
                    if (remaining > 0) {
                        await enqueueLinks({
                            urls: links.slice(0, remaining),
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
                    }
                }
                return;
            }

            if (label === 'DETAIL') {
                if (saved >= RESULTS_WANTED) return;

                try {
                    const json = extractFromJsonLd($) || {};
                    const data = { ...json };

                    // Fallback selectors for core fields
                    if (!data.title) {
                        data.title =
                            $('h1.job-title, .job-title h1, .title h1, h1').first().text().trim() ||
                            $('[class*="job-title"]').first().text().trim() ||
                            null;
                    }
                    if (!data.company) {
                        data.company =
                            $('.company-name, .employer-name, [class*="company"], a[href*="nha-tuyen-dung"]')
                                .first()
                                .text()
                                .trim() || null;
                    }
                    if (!data.location) {
                        data.location =
                            $('[class*="location"], [class*="address"], .location span').first().text().trim() ||
                            null;
                    }
                    if (!data.salary) {
                        data.salary =
                            $('[class*="salary"], .salary, [class*="luong"]').first().text().trim() ||
                            null;
                    }
                    if (!data.job_type) {
                        data.job_type =
                            $('[class*="job-type"], [class*="employment"]').first().text().trim() ||
                            null;
                    }
                    if (!data.date_posted) {
                        const dt =
                            $('[class*="date"], [class*="posted"], time').first().attr('datetime') ||
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

                    // Optional: discard too-old jobs by days
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
                    // retire session on typical block clues
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

    log.info(`Starting with ${initial.length} start URL(s). Target: ${RESULTS_WANTED} results, max pages ${MAX_PAGES}.`);

    await crawler.run(
        initial.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })),
    );

    log.info(`Finished. Saved ${saved} item(s).`);
} catch (e) {
    log.exception(e, 'Actor failed');
    process.exitCode = 1;
} finally {
    await Actor.exit();
}

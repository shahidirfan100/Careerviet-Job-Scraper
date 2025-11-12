// Careerviet.vn jobs scraper - Production-ready CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { createHeaderGenerator } from 'header-generator';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            max_age_days, dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

        const toAbs = (href, base = 'https://careerviet.vn') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe, .hidden, [style*="display:none"]').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc) => {
            const params = new URLSearchParams();
            if (kw) params.set('keyword', kw);
            if (loc) params.set('location', loc);
            if (max_age_days) {
                // Map days to Careerviet filter values
                const ageMap = { 1: '24h', 7: '7d', 30: '30d' };
                params.set('posted', ageMap[max_age_days] || '');
            }
            const query = params.toString();
            return query ? `https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam?${query}` : 'https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam';
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        // Header generator for stealth - configured for Careerviet.vn
        const headerGenerator = createHeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 140, maxVersion: 142 },
                { name: 'firefox', minVersion: 120 },
                { name: 'safari', minVersion: 16 },
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos'],
            locales: ['en-US', 'vi-VN'],
        });

        let saved = 0;
        const seenUrls = new Set();

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Match job detail URLs
                if (/careerviet\.vn\/vi\/tim-viec-lam\/[^\/]+\.\w+\.html/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && (!dedupe || !seenUrls.has(abs))) {
                        links.add(abs);
                        if (dedupe) seenUrls.add(abs);
                    }
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPage) {
            // Look for pagination links
            const nextPage = currentPage + 1;
            const nextLink = $(`a[href*="${nextPage}"], a:contains("${nextPage}")`).filter((_, el) => {
                const href = $(el).attr('href');
                return href && /trang-\d+-vi\.html|page=\d+/i.test(href);
            }).first().attr('href');
            if (nextLink) return toAbs(nextLink, base);

            // Alternative: find "Next" button
            const nextBtn = $('a[title*="next"], a:contains("Tiếp"), .pagination a:last-child').filter((_, el) => {
                const text = $(el).text().trim().toLowerCase();
                return text.includes('next') || text.includes('tiếp') || $(el).attr('title')?.toLowerCase().includes('next');
            }).first().attr('href');
            if (nextBtn) return toAbs(nextBtn, base);

            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: true,
            maxConcurrency: 5, // Lower for stealth
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,
            preNavigationHooks: [
                async (ctx) => {
                    // Add realistic headers
                    const headers = headerGenerator.getHeaders();
                    ctx.request.headers = { ...ctx.request.headers, ...headers };
                    // Set referer based on label
                    if (ctx.request.userData?.label === 'LIST') {
                        ctx.request.headers.referer = 'https://careerviet.vn/vi/';
                    } else if (ctx.request.userData?.label === 'DETAIL') {
                        ctx.request.headers.referer = 'https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam';
                    }
                    // Add random delay
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
                },
            ],
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Add delay between requests
                await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links on page ${pageNo}`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await enqueueLinks({
                                urls: toEnqueue,
                                userData: { label: 'DETAIL' },
                                forefront: false, // Queue normally
                            });
                        }
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(toPush.map(u => ({
                                url: u,
                                title: null,
                                company: null,
                                location: null,
                                _source: 'careerviet.vn'
                            })));
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
                        const json = extractFromJsonLd($);
                        const data = json || {};

                        // Enhanced selectors for Careerviet.vn
                        if (!data.title) {
                            data.title = $('h1.job-title, .job-title h1, .title h1, h1').first().text().trim() ||
                                        $('[class*="job-title"]').first().text().trim() || null;
                        }
                        if (!data.company) {
                            data.company = $('.company-name, .employer-name, [class*="company"], a[href*="nha-tuyen-dung"]')
                                .first().text().trim() || null;
                        }
                        if (!data.location) {
                            data.location = $('[class*="location"], [class*="address"], .location span').first().text().trim() || null;
                        }
                        if (!data.salary) {
                            data.salary = $('[class*="salary"], .salary, [class*="luong"]').first().text().trim() || null;
                        }
                        if (!data.job_type) {
                            data.job_type = $('[class*="job-type"], [class*="employment"]').first().text().trim() || null;
                        }
                        if (!data.date_posted) {
                            const dateText = $('[class*="date"], [class*="posted"], time').first().text().trim() ||
                                           $('[class*="date"]').first().attr('datetime');
                            data.date_posted = dateText || null;
                        }
                        if (!data.description_html) {
                            const descSelectors = [
                                '.job-description',
                                '.description',
                                '[class*="description"]',
                                '.content',
                                '[class*="content"]',
                                '.entry-content'
                            ];
                            for (const sel of descSelectors) {
                                const desc = $(sel).first();
                                if (desc.length && desc.html().trim()) {
                                    data.description_html = desc.html().trim();
                                    break;
                                }
                            }
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;

                        // Filter by age if specified
                        if (max_age_days && data.date_posted) {
                            const postedDate = new Date(data.date_posted);
                            const now = new Date();
                            const diffDays = (now - postedDate) / (1000 * 60 * 60 * 24);
                            if (diffDays > +max_age_days) {
                                crawlerLog.info(`Skipping old job: ${data.title} (${diffDays.toFixed(1)} days old)`);
                                return;
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
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job ${saved}/${RESULTS_WANTED}: ${data.title}`);
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items from Careerviet.vn`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });

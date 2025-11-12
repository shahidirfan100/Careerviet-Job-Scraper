# Careerviet.vn Jobs Scraper

Scrape job listings from Careerviet.vn, Vietnam's leading job search platform. Extract comprehensive job data including titles, companies, locations, salaries, and descriptions for efficient job market analysis and recruitment.

## What Does This Actor Do?

This Apify actor automatically scrapes job listings from Careerviet.vn, the most popular job search website in Vietnam. It collects detailed information about available positions across various industries and locations, making it perfect for:

- Job market research and analysis
- Recruitment agencies sourcing candidates
- Companies monitoring competitor hiring
- Data analysts studying employment trends
- HR professionals finding talent

## Key Features

- **Comprehensive Data Extraction**: Captures job titles, company names, locations, posting dates, salaries, and full descriptions
- **Flexible Search Options**: Search by keywords, locations, or specific URLs
- **Pagination Handling**: Automatically navigates through multiple result pages
- **Detail Page Scraping**: Optionally fetches complete job descriptions from individual pages
- **Structured Output**: Consistent JSON format for easy data processing
- **Rate Limiting**: Built-in delays to respect website policies
- **Proxy Support**: Uses residential proxies for reliable scraping

## Input Parameters

Configure your scraping job with these parameters:

### Basic Search
- **keyword** (string): Job title, skill, or company to search for (e.g., "software engineer", "marketing manager")
- **location** (string): City or region filter (e.g., "Hồ Chí Minh", "Hà Nội", "Đà Nẵng")

### Advanced Options
- **startUrl** (string): Direct Careerviet.vn search URL to start scraping from (overrides keyword/location)
- **results_wanted** (integer): Maximum jobs to collect (default: 100, max: 10000)
- **max_pages** (integer): Maximum search result pages to visit (default: 20)
- **max_age_days** (integer): Filter jobs by posting date (1 = within 24 hours, 7 = within 7 days, 30 = within 30 days)
- **collectDetails** (boolean): Enable to scrape full job descriptions from detail pages (default: true)

### Technical Settings
- **proxyConfiguration**: Use Apify Proxy for best results (recommended: Residential proxies)
- **cookies** (string): Custom cookies if needed for specific scenarios
- **cookiesJson** (object): JSON-formatted cookies array
- **dedupe** (boolean): Remove duplicate job URLs (default: true)

## Output Format

Each scraped job is saved as a JSON object with this structure:

```json
{
  "title": "Senior Software Engineer",
  "company": "Tech Solutions Vietnam",
  "location": "Hồ Chí Minh",
  "salary": "15-25 triệu VND",
  "job_type": "Full-time",
  "date_posted": "2025-11-10",
  "description_html": "<p>We are looking for a skilled software engineer...</p>",
  "description_text": "We are looking for a skilled software engineer with experience in React and Node.js...",
  "url": "https://careerviet.vn/vi/tim-viec-lam/senior-software-engineer.35ABC123.html"
}
```

## Usage Examples

### Basic Job Search
```json
{
  "keyword": "data analyst",
  "location": "Hà Nội",
  "results_wanted": 50
}
```

### Advanced Configuration
```json
{
  "keyword": "marketing",
  "location": "Hồ Chí Minh",
  "max_age_days": 7,
  "collectDetails": true,
  "results_wanted": 200,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Custom URL Scraping
```json
{
  "startUrl": "https://careerviet.vn/vi/tim-viec-lam/tat-ca-viec-lam",
  "results_wanted": 1000
}
```

## How It Works

1. **Search Initiation**: Starts from Careerviet.vn's job search page or a custom URL
2. **Result Collection**: Extracts job listings from search result pages
3. **Detail Extraction**: Visits individual job pages for complete information (if enabled)
4. **Data Processing**: Cleans and structures the extracted data
5. **Output Storage**: Saves results to Apify dataset in JSON format

## Limits and Performance

- **Rate Limiting**: Includes delays between requests to avoid being blocked
- **Concurrency**: Optimized for reliable scraping without overwhelming the target site
- **Data Volume**: Can handle thousands of jobs per run
- **Geographic Focus**: Primarily designed for Vietnamese job market

## Cost Estimation

- **Free Tier**: Up to 100 jobs per run
- **Paid Usage**: ~$0.10 per 1000 jobs (depending on proxy usage)
- **Compute Units**: Approximately 0.01 CU per job with details enabled

## Tips for Best Results

- Use specific keywords for better targeting
- Enable proxy configuration for maximum reliability
- Set reasonable `results_wanted` limits to control costs
- Use `max_age_days` to focus on recent postings
- Monitor your dataset for any changes in job availability

## Troubleshooting

- **Low Results**: Try broader keywords or remove location filter
- **Timeout Errors**: Reduce `results_wanted` or increase timeouts
- **Blocked Requests**: Ensure proxy configuration is enabled
- **Missing Descriptions**: Verify `collectDetails` is set to true

## Changelog

### Version 1.0.0
- Initial release with full Careerviet.vn scraping capabilities
- Support for keyword/location search and custom URLs
- Comprehensive job data extraction
- Proxy and cookie support

## Support

For issues or feature requests, please contact Apify support or create an issue in the actor's repository.

---

**Keywords**: job scraper, Vietnam jobs, Careerviet.vn, recruitment data, job market analysis, Vietnamese employment, career opportunities, hiring trends
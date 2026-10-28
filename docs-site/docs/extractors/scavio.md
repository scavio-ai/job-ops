---
id: scavio
title: Scavio Extractor
description: Optional LinkedIn and Indeed job search through the Scavio API, for servers where direct scraping is blocked.
sidebar_position: 11
---

## What it is

Original website: [Scavio](https://scavio.dev/)

This extractor adds two optional sources, **LinkedIn (Scavio)** and **Indeed (Scavio)**, that search LinkedIn and Indeed through the Scavio API instead of scraping them from your server. It needs a Scavio API key, and each request uses Scavio credits.

## Why it exists

The built-in [JobSpy](/docs/next/extractors/jobspy) sources are free, but LinkedIn and Indeed often rate-limit or block datacenter IP addresses, so self-hosted runs can come back empty. These sources make the requests from Scavio's side, so they need no proxy. They use separate source ids and never replace the JobSpy sources; you can run both, and jobs found by both are stored once.

## How to use it

1. Create a Scavio account at [scavio.dev](https://scavio.dev/) and copy your API key from the dashboard.
2. Open **Settings**, then **Environment & Workspaces**, and paste it into **Scavio > API Key**. You can also set `SCAVIO_API_KEY` in `.env` and restart.
3. Open **Run jobs**, choose **Automatic**, and enable **LinkedIn (Scavio)**, **Indeed (Scavio)**, or both under **Sources**.
4. Set search terms and a country or cities as usual, then start the run.

Defaults and constraints:

- **Indeed (Scavio)** searches indeed.com, so it only runs when the selected country is the United States. Selected cities are passed to Indeed as locations.
- **LinkedIn (Scavio)** filters by country only. Selected cities are not applied to LinkedIn.
- Each source fetches at most `SCAVIO_MAX_JOBS_PER_TERM` jobs per search term (default `25`), or less when the automatic run budget gives it a smaller share.
- Indeed jobs include the full description. LinkedIn search results have no description unless `SCAVIO_LINKEDIN_FETCH_DESCRIPTION=true`, which costs an extra request per job.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SCAVIO_API_KEY` | Yes, unless set in Settings | — | Scavio API key. A key saved in Settings takes precedence for that workspace. |
| `SCAVIO_MAX_JOBS_PER_TERM` | No | `25` | Upper limit on jobs fetched per search term, per source. |
| `SCAVIO_LINKEDIN_FETCH_DESCRIPTION` | No | `false` | Fetch the full LinkedIn job description for each result. |

## Cost

Requests are billed in Scavio credits:

| Request | Credits |
|---|---|
| Indeed search, one page | 2 |
| Indeed job description | 2 per job |
| LinkedIn search, one page of 25 | 10 |
| LinkedIn job description (opt-in) | 30 per job |

With the defaults, one search term costs roughly 55 credits on Indeed (25 jobs with descriptions) and 10 credits on LinkedIn (25 jobs without descriptions). New accounts get 50 free credits once; paid plans start at 7,000 credits for $30 a month.

## Common problems

### The Scavio sources do not appear under Sources

- Confirm a Scavio API key is saved in **Settings** or `SCAVIO_API_KEY` is set, and restart after changing `.env`.
- Check `GET /api/scavio_indeed/health` or `GET /api/scavio_linkedin/health`. A health check runs a one-job search and uses a few credits.

### Indeed (Scavio) is skipped

- Indeed (Scavio) only supports the United States. Runs for other countries skip it and log the source as incompatible.

### The run reports "out of credits (402)" or "rejected the API key (401)"

- The run stops calling Scavio for that source and keeps any jobs already found. Top up credits or replace the key, then run again.

### LinkedIn jobs have no description

- This is the default. Set `SCAVIO_LINKEDIN_FETCH_DESCRIPTION=true` to fetch descriptions, or open the job and paste the description manually. About one in five LinkedIn results has no detail record; those jobs are kept without a description and that request is not billed.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [JobSpy](/docs/next/extractors/jobspy)
- [Add an Extractor](/docs/next/workflows/add-an-extractor)

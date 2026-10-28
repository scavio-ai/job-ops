import type { CreateJobInput } from "@shared/types/jobs";

const SCAVIO_API_BASE_URL = "https://api.scavio.dev";
const REQUEST_TIMEOUT_MS = 60_000;
// Guards against a looping cursor or a source that keeps returning repeats.
const MAX_PAGES_PER_QUERY = 10;

export type ScavioSource = "scavio_linkedin" | "scavio_indeed";

export interface ScavioProgressEvent {
  type: "term_start" | "term_complete";
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  jobsFoundTerm?: number;
}

export interface RunScavioOptions {
  source: ScavioSource;
  apiKey: string;
  searchTerms?: string[];
  selectedCountry?: string;
  locations?: string[];
  maxJobsPerTerm?: number;
  fetchLinkedinDescriptions?: boolean;
  onProgress?: (event: ScavioProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface ScavioResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item): item is string => Boolean(item))
    : [];
}

function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function joinList(values: string[]): string | undefined {
  return values.length > 0 ? values.join(", ") : undefined;
}

export class ScavioRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ScavioRequestError";
  }
}

// Upstream bodies are never echoed: they can carry account details.
function describeFailure(status: number): string {
  if (status === 401) return "Scavio rejected the API key (401)";
  if (status === 402) {
    return "Scavio account is out of credits (402); top up at https://dashboard.scavio.dev/billing";
  }
  if (status === 429) return "Scavio rate limit reached (429)";
  return `Scavio request failed with status ${status}`;
}

export async function postScavio(args: {
  path: string;
  body: UnknownRecord;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<UnknownRecord> {
  const response = await (args.fetchImpl ?? fetch)(
    `${SCAVIO_API_BASE_URL}${args.path}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new ScavioRequestError(
      describeFailure(response.status),
      response.status,
    );
  }

  const payload = asRecord((await response.json()) as unknown);
  const data = asRecord(payload?.data);
  if (!data) throw new Error("Scavio returned an invalid response");
  return data;
}

// --- Indeed ---------------------------------------------------------------

export function indeedJobUrl(jobKey: string): string {
  return `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jobKey)}`;
}

export function mapIndeedJob(
  value: unknown,
  detail?: UnknownRecord | null,
): CreateJobInput | null {
  const row = asRecord(value);
  const jobKey = asString(row?.job_key);
  const title = asString(detail?.title) ?? asString(row?.title);
  const employer = asString(detail?.company) ?? asString(row?.company);
  if (!row || !jobKey || !title || !employer) return null;

  const pick = (key: string) => detail?.[key] ?? row[key];
  const jobUrl = indeedJobUrl(jobKey);
  const directUrl = asHttpUrl(detail?.original_job_url);
  const jobTypes = asStringList(pick("job_types"));

  return {
    source: "scavio_indeed",
    sourceJobId: jobKey,
    title,
    employer,
    employerUrl: asHttpUrl(pick("company_url")),
    jobUrl,
    jobUrlDirect: directUrl,
    applicationLink: directUrl ?? jobUrl,
    location: asString(pick("location")),
    jobDescription: asString(detail?.description) ?? asString(row.snippet),
    datePosted: asString(pick("posted_at")),
    salary: asString(pick("salary_text")),
    salarySource: asString(pick("salary_source")),
    salaryInterval: asString(pick("salary_period")),
    salaryMinAmount: asNumber(pick("salary_min")),
    salaryMaxAmount: asNumber(pick("salary_max")),
    salaryCurrency: asString(pick("salary_currency")),
    jobType: joinList(jobTypes),
    isRemote: pick("remote") === true,
    companyLogo: asHttpUrl(pick("company_logo")),
    companyRating: asNumber(pick("company_rating")),
    companyReviewsCount: asNumber(pick("company_review_count")),
  };
}

async function fetchIndeedDetail(args: {
  jobKey: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<UnknownRecord | null> {
  try {
    return await postScavio({
      path: "/api/v1/indeed/job",
      body: { job_id: args.jobKey },
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
  } catch (error) {
    // A missing or expired posting keeps its search snippet; account-level
    // failures stop the run instead of being retried per job.
    if (
      error instanceof ScavioRequestError &&
      [404, 410].includes(error.status)
    )
      return null;
    throw error;
  }
}

async function searchIndeed(args: {
  searchTerm: string;
  location?: string;
  limit: number;
  apiKey: string;
  seenKeys: Set<string>;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}): Promise<CreateJobInput[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
    if (rows.length >= args.limit || args.shouldCancel?.()) break;

    const data = await postScavio({
      path: "/api/v1/indeed/search",
      body: {
        query: args.searchTerm,
        ...(args.location ? { location: args.location } : {}),
        page,
      },
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
    const pageRows = Array.isArray(data.jobs) ? data.jobs : [];
    let added = 0;
    for (const value of pageRows) {
      const jobKey = asString(asRecord(value)?.job_key);
      if (!jobKey || args.seenKeys.has(jobKey)) continue;
      args.seenKeys.add(jobKey);
      rows.push(value);
      added += 1;
      if (rows.length >= args.limit) break;
    }
    if (added === 0) break;
  }

  const jobs: CreateJobInput[] = [];
  for (const value of rows) {
    if (args.shouldCancel?.()) break;
    const jobKey = asString(asRecord(value)?.job_key) as string;
    const detail = await fetchIndeedDetail({
      jobKey,
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
    const job = mapIndeedJob(value, detail);
    if (job) jobs.push(job);
  }
  return jobs;
}

// --- LinkedIn -------------------------------------------------------------

export function linkedinJobId(value: unknown): string | undefined {
  const raw = asString(value);
  return raw?.match(/(\d{6,})\/?(?:\?|$)/)?.[1] ?? raw?.match(/^\d+$/)?.[0];
}

export function linkedinJobUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${jobId}`;
}

export function mapLinkedinJob(
  value: unknown,
  detail?: UnknownRecord | null,
): CreateJobInput | null {
  const row = asRecord(value);
  const jobId = linkedinJobId(row?.id) ?? linkedinJobId(row?.url);
  const title = asString(detail?.title) ?? asString(row?.title);
  const company = asRecord(detail?.company);
  const employer = asString(company?.name) ?? asString(row?.company);
  if (!row || !jobId || !title || !employer) return null;

  const jobUrl = linkedinJobUrl(jobId);
  const workplaceType = asString(row.workplace_type);

  return {
    source: "scavio_linkedin",
    sourceJobId: jobId,
    title,
    employer,
    employerUrl: asHttpUrl(company?.url) ?? asHttpUrl(row.company_url),
    jobUrl,
    applicationLink: jobUrl,
    location: asString(detail?.location) ?? asString(row.location),
    jobDescription: asString(detail?.description),
    datePosted: asString(detail?.posted_at) ?? asString(row.posted_at),
    salary: asString(detail?.salary) ?? asString(row.salary),
    jobType: asString(detail?.employment_type),
    jobLevel: asString(detail?.experience_level),
    jobFunction: joinList(asStringList(detail?.job_functions)),
    companyIndustry: joinList(asStringList(detail?.industries)),
    companyLogo: asHttpUrl(row.company_logo),
    companyDescription: asString(company?.description),
    companyNumEmployees: asString(company?.employee_range),
    skills: joinList(asStringList(detail?.skills)),
    isRemote:
      detail?.is_remote === true || workplaceType?.toLowerCase() === "remote",
    workFromHomeType: workplaceType,
  };
}

async function fetchLinkedinDetail(args: {
  jobId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<UnknownRecord | null> {
  try {
    return await postScavio({
      path: "/api/v1/linkedin/job",
      body: { job_id: args.jobId },
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
  } catch (error) {
    // Roughly one in five LinkedIn search results has no detail record (404,
    // not billed); keep the search result without a description.
    if (error instanceof ScavioRequestError && error.status === 404)
      return null;
    throw error;
  }
}

async function searchLinkedin(args: {
  searchTerm: string;
  location?: string;
  limit: number;
  fetchDescriptions: boolean;
  apiKey: string;
  seenIds: Set<string>;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}): Promise<CreateJobInput[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
    if (rows.length >= args.limit || args.shouldCancel?.()) break;

    const data = await postScavio({
      path: "/api/v1/linkedin/search/jobs",
      body: {
        search: args.searchTerm,
        ...(args.location ? { location: args.location } : {}),
        ...(cursor ? { cursor } : {}),
      },
      apiKey: args.apiKey,
      fetchImpl: args.fetchImpl,
    });
    // LinkedIn rotates its result set, so pages overlap: dedupe by job id.
    for (const value of Array.isArray(data.data) ? data.data : []) {
      const row = asRecord(value);
      const jobId = linkedinJobId(row?.id) ?? linkedinJobId(row?.url);
      if (!jobId || args.seenIds.has(jobId)) continue;
      args.seenIds.add(jobId);
      rows.push(value);
      if (rows.length >= args.limit) break;
    }
    cursor = asString(data.next_cursor);
    if (!cursor) break;
  }

  const jobs: CreateJobInput[] = [];
  for (const value of rows) {
    if (args.shouldCancel?.()) break;
    const row = asRecord(value);
    const jobId = (linkedinJobId(row?.id) ?? linkedinJobId(row?.url)) as string;
    const detail = args.fetchDescriptions
      ? await fetchLinkedinDetail({
          jobId,
          apiKey: args.apiKey,
          fetchImpl: args.fetchImpl,
        })
      : null;
    const job = mapLinkedinJob(value, detail);
    if (job) jobs.push(job);
  }
  return jobs;
}

// --- Run ------------------------------------------------------------------

function toTitleCase(value: string): string {
  return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export async function runScavio(
  options: RunScavioOptions,
): Promise<ScavioResult> {
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = Number.isFinite(options.maxJobsPerTerm)
    ? Math.max(1, Math.floor(options.maxJobsPerTerm as number))
    : 25;
  // LinkedIn filters by country only; Indeed takes a city, state or postal code.
  const queryLocations =
    options.source === "scavio_indeed"
      ? options.locations?.length
        ? options.locations
        : [undefined]
      : [
          options.selectedCountry
            ? toTitleCase(options.selectedCountry)
            : undefined,
        ];
  const perLocationLimit = Math.max(
    1,
    Math.ceil(maxJobsPerTerm / queryLocations.length),
  );
  const jobs: CreateJobInput[] = [];
  const seenIds = new Set<string>();

  try {
    for (const [index, searchTerm] of searchTerms.entries()) {
      if (options.shouldCancel?.()) return { success: true, jobs };

      const termIndex = index + 1;
      options.onProgress?.({
        type: "term_start",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
      });

      let jobsFoundTerm = 0;
      for (const location of queryLocations) {
        if (options.shouldCancel?.()) break;
        const found =
          options.source === "scavio_indeed"
            ? await searchIndeed({
                searchTerm,
                location,
                limit: perLocationLimit,
                apiKey: options.apiKey,
                seenKeys: seenIds,
                shouldCancel: options.shouldCancel,
                fetchImpl: options.fetchImpl,
              })
            : await searchLinkedin({
                searchTerm,
                location,
                limit: perLocationLimit,
                fetchDescriptions: options.fetchLinkedinDescriptions ?? false,
                apiKey: options.apiKey,
                seenIds,
                shouldCancel: options.shouldCancel,
                fetchImpl: options.fetchImpl,
              });
        jobs.push(...found);
        jobsFoundTerm += found.length;
      }

      options.onProgress?.({
        type: "term_complete",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm,
      });
    }

    return { success: true, jobs };
  } catch (error) {
    return {
      success: false,
      jobs,
      error:
        error instanceof Error
          ? error.message
          : "Unexpected error while running Scavio extractor",
    };
  }
}

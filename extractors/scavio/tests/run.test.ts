import { describe, expect, it, vi } from "vitest";
import {
  linkedinJobId,
  mapIndeedJob,
  mapLinkedinJob,
  runScavio,
} from "../src/run";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function requestOf(call: unknown[]): {
  path: string;
  body: Record<string, unknown>;
} {
  const [url, init] = call as [string, RequestInit];
  return {
    path: new URL(url).pathname,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

const indeedRow = (jobKey: string) => ({
  job_key: jobKey,
  title: "Data Analyst",
  company: "Acme",
  location: "Austin, TX 78702",
  posted_at: "2026-10-13T05:00:00.000Z",
  snippet: "Analyze user behavior.",
  remote: false,
  job_types: ["Full-time"],
  salary_text: "$80,000 - $95,000 a year",
  salary_min: 80000,
  salary_max: 95000,
  salary_period: "year",
  salary_currency: "USD",
});

const linkedinRow = (jobId: string) => ({
  id: `urn:li:jobPosting:${jobId}`,
  title: "Backend Engineer",
  url: `https://www.linkedin.com/jobs/view/backend-engineer-at-acme-${jobId}?trk=public`,
  company: "Acme",
  company_url: "https://www.linkedin.com/company/acme",
  location: "New York, NY",
  posted_at: "2026-10-20",
  workplace_type: "Remote",
});

describe("Scavio extractor mapping", () => {
  it("normalizes LinkedIn job ids from URNs and URLs", () => {
    expect(linkedinJobId("urn:li:jobPosting:4415427228")).toBe("4415427228");
    expect(
      linkedinJobId(
        "https://www.linkedin.com/jobs/view/backend-engineer-at-acme-4415427228?trk=x",
      ),
    ).toBe("4415427228");
    expect(linkedinJobId("4415427228")).toBe("4415427228");
    expect(linkedinJobId("not-a-job")).toBeUndefined();
  });

  it("maps Indeed results to the jobspy URL form and prefers detail fields", () => {
    const job = mapIndeedJob(indeedRow("1d9d5ad6081ee5e0"), {
      description: "Full description",
      original_job_url: "https://careers.acme.com/jobs/42",
    });

    expect(job).toMatchObject({
      source: "scavio_indeed",
      sourceJobId: "1d9d5ad6081ee5e0",
      title: "Data Analyst",
      employer: "Acme",
      jobUrl: "https://www.indeed.com/viewjob?jk=1d9d5ad6081ee5e0",
      jobUrlDirect: "https://careers.acme.com/jobs/42",
      applicationLink: "https://careers.acme.com/jobs/42",
      jobDescription: "Full description",
      salaryMinAmount: 80000,
      salaryMaxAmount: 95000,
      salaryCurrency: "USD",
      jobType: "Full-time",
      isRemote: false,
    });
  });

  it("falls back to the Indeed snippet when there is no detail record", () => {
    expect(mapIndeedJob(indeedRow("abc"), null)?.jobDescription).toBe(
      "Analyze user behavior.",
    );
    expect(mapIndeedJob({ job_key: "abc", title: "No employer" })).toBeNull();
  });

  it("maps LinkedIn results to the canonical jobs/view URL", () => {
    const job = mapLinkedinJob(linkedinRow("4415427228"), {
      description: "Build APIs",
      employment_type: "Full-time",
      skills: ["Go", "Postgres"],
      company: { name: "Acme Corp", employee_range: "51-200" },
    });

    expect(job).toMatchObject({
      source: "scavio_linkedin",
      sourceJobId: "4415427228",
      employer: "Acme Corp",
      jobUrl: "https://www.linkedin.com/jobs/view/4415427228",
      jobDescription: "Build APIs",
      jobType: "Full-time",
      skills: "Go, Postgres",
      companyNumEmployees: "51-200",
      isRemote: true,
    });
  });
});

describe("runScavio", () => {
  it("pages Indeed search up to the cap, dedupes, and fetches each description", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const { path, body } = requestOf([url, init]);
      if (path === "/api/v1/indeed/search") {
        return jsonResponse({
          data: {
            jobs:
              body.page === 1
                ? [indeedRow("a"), indeedRow("b"), indeedRow("a")]
                : [indeedRow("c"), indeedRow("d")],
          },
        });
      }
      return jsonResponse({
        data: { description: `Description for ${String(body.job_id)}` },
      });
    }) as unknown as typeof fetch;

    const result = await runScavio({
      source: "scavio_indeed",
      apiKey: "sk_test",
      searchTerms: ["data analyst"],
      locations: ["Austin, TX"],
      maxJobsPerTerm: 3,
      fetchImpl,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["a", "b", "c"]);
    expect(result.jobs[2]?.jobDescription).toBe("Description for c");

    const calls = vi.mocked(fetchImpl).mock.calls.map(requestOf);
    expect(
      calls.filter((call) => call.path === "/api/v1/indeed/search"),
    ).toEqual([
      {
        path: "/api/v1/indeed/search",
        body: { query: "data analyst", location: "Austin, TX", page: 1 },
      },
      {
        path: "/api/v1/indeed/search",
        body: { query: "data analyst", location: "Austin, TX", page: 2 },
      },
    ]);
    expect(
      calls.filter((call) => call.path === "/api/v1/indeed/job"),
    ).toHaveLength(3);

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer sk_test",
    );
  });

  it("follows the LinkedIn cursor, sends the country, and skips paid detail calls by default", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const { body } = requestOf([url, init]);
      return jsonResponse({
        data: body.cursor
          ? {
              data: [linkedinRow("2000002"), linkedinRow("3000003")],
              next_cursor: null,
            }
          : {
              data: [linkedinRow("1000001"), linkedinRow("2000002")],
              next_cursor: "c2",
            },
      });
    }) as unknown as typeof fetch;

    const result = await runScavio({
      source: "scavio_linkedin",
      apiKey: "sk_test",
      searchTerms: ["backend engineer"],
      selectedCountry: "united states",
      maxJobsPerTerm: 10,
      fetchImpl,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      "1000001",
      "2000002",
      "3000003",
    ]);
    const calls = vi.mocked(fetchImpl).mock.calls.map(requestOf);
    expect(calls).toEqual([
      {
        path: "/api/v1/linkedin/search/jobs",
        body: { search: "backend engineer", location: "United States" },
      },
      {
        path: "/api/v1/linkedin/search/jobs",
        body: {
          search: "backend engineer",
          location: "United States",
          cursor: "c2",
        },
      },
    ]);
  });

  it("keeps a LinkedIn job without a detail record when descriptions are enabled", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).pathname === "/api/v1/linkedin/job") {
        return jsonResponse({ error: "Not found" }, 404);
      }
      return jsonResponse({
        data: { data: [linkedinRow("1000001")], next_cursor: null },
      });
    }) as unknown as typeof fetch;

    const result = await runScavio({
      source: "scavio_linkedin",
      apiKey: "sk_test",
      searchTerms: ["backend engineer"],
      fetchLinkedinDescriptions: true,
      fetchImpl,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.jobDescription).toBeUndefined();
  });

  it("reports account failures without echoing the upstream body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "Insufficient credits", email: "owner@example.com" },
        402,
      ),
    ) as unknown as typeof fetch;

    const result = await runScavio({
      source: "scavio_indeed",
      apiKey: "sk_test",
      searchTerms: ["data analyst"],
      fetchImpl,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("out of credits (402)");
    expect(result.error).not.toContain("owner@example.com");
  });

  it("stops between calls when the run is cancelled", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => {
      cancelled = true;
      return jsonResponse({ data: { jobs: [indeedRow("a"), indeedRow("b")] } });
    }) as unknown as typeof fetch;

    const result = await runScavio({
      source: "scavio_indeed",
      apiKey: "sk_test",
      searchTerms: ["data analyst", "data engineer"],
      maxJobsPerTerm: 10,
      shouldCancel: () => cancelled,
      fetchImpl,
    });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

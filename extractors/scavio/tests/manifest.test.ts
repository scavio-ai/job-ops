import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runScavio: vi.fn(),
}));

describe("scavio manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SCAVIO_API_KEY", "");
    vi.stubEnv("SCAVIO_MAX_JOBS_PER_TERM", "");
    vi.stubEnv("SCAVIO_LINKEDIN_FETCH_DESCRIPTION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares both sources and limits Indeed to the United States", async () => {
    const { manifest } = await import("../src/manifest");

    expect(manifest.providesSources).toEqual([
      "scavio_linkedin",
      "scavio_indeed",
    ]);
    expect(manifest.locationCapabilities).toEqual({
      scavio_linkedin: { supportedCountryKeys: null },
      scavio_indeed: { supportedCountryKeys: ["united states"] },
    });
  });

  it("fails before any request when no API key is configured", async () => {
    const { manifest } = await import("../src/manifest");
    const { runScavio } = await import("../src/run");

    const result = await manifest.run({
      source: "scavio_indeed",
      selectedSources: ["scavio_indeed"],
      settings: {},
      searchTerms: ["data analyst"],
      selectedCountry: "united states",
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("SCAVIO_API_KEY");
    expect(runScavio).not.toHaveBeenCalled();
  });

  it("prefers the workspace key and caps results at the shared run budget", async () => {
    vi.stubEnv("SCAVIO_API_KEY", "sk_env");
    const { manifest } = await import("../src/manifest");
    const { runScavio } = await import("../src/run");
    vi.mocked(runScavio).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "scavio_linkedin",
      selectedSources: ["scavio_linkedin", "scavio_indeed"],
      settings: {
        scavioApiKey: "sk_workspace",
        jobspyResultsWanted: "8",
        searchCities: "Austin, TX",
      },
      searchTerms: ["data analyst"],
      selectedCountry: "united states",
    });

    expect(runScavio).toHaveBeenCalledTimes(2);
    expect(runScavio).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "scavio_linkedin",
        apiKey: "sk_workspace",
        maxJobsPerTerm: 8,
        fetchLinkedinDescriptions: false,
      }),
    );
    expect(runScavio).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        source: "scavio_indeed",
        locations: ["Austin, TX"],
      }),
    );
  });

  it("never exceeds the Scavio per-term ceiling", async () => {
    vi.stubEnv("SCAVIO_MAX_JOBS_PER_TERM", "10");
    const { manifest } = await import("../src/manifest");
    const { runScavio } = await import("../src/run");
    vi.mocked(runScavio).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "scavio_indeed",
      selectedSources: ["scavio_indeed"],
      settings: { scavioApiKey: "sk_workspace", jobspyResultsWanted: "500" },
      searchTerms: ["data analyst"],
      selectedCountry: "united states",
    });

    expect(runScavio).toHaveBeenCalledWith(
      expect.objectContaining({ maxJobsPerTerm: 10 }),
    );
  });

  it("returns jobs from a working source and reports the failing one", async () => {
    const { manifest } = await import("../src/manifest");
    const { runScavio } = await import("../src/run");
    vi.mocked(runScavio)
      .mockResolvedValueOnce({
        success: false,
        jobs: [],
        error: "Scavio request failed with status 502",
      })
      .mockResolvedValueOnce({
        success: true,
        jobs: [
          {
            source: "scavio_indeed",
            title: "Data Analyst",
            employer: "Acme",
            jobUrl: "https://www.indeed.com/viewjob?jk=a",
          },
        ],
      });

    const result = await manifest.run({
      source: "scavio_linkedin",
      selectedSources: ["scavio_linkedin", "scavio_indeed"],
      settings: { scavioApiKey: "sk_workspace" },
      searchTerms: ["data analyst"],
      selectedCountry: "united states",
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.sourceErrors).toEqual([
      "scavio_linkedin: Scavio request failed with status 502",
    ]);
  });

  it("keeps jobs found before a source fails mid-run", async () => {
    const { manifest } = await import("../src/manifest");
    const { runScavio } = await import("../src/run");
    vi.mocked(runScavio).mockResolvedValue({
      success: false,
      jobs: [
        {
          source: "scavio_indeed",
          title: "Data Analyst",
          employer: "Acme",
          jobUrl: "https://www.indeed.com/viewjob?jk=a",
        },
      ],
      error: "Scavio account is out of credits (402)",
    });

    const result = await manifest.run({
      source: "scavio_indeed",
      selectedSources: ["scavio_indeed"],
      settings: { scavioApiKey: "sk_workspace" },
      searchTerms: ["data analyst"],
      selectedCountry: "united states",
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.sourceErrors?.[0]).toContain("out of credits (402)");
  });
});

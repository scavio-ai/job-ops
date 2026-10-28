import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";
import { runScavio, type ScavioProgressEvent, type ScavioSource } from "./run";

const SOURCE_LABELS: Record<ScavioSource, string> = {
  scavio_linkedin: "LinkedIn (Scavio)",
  scavio_indeed: "Indeed (Scavio)",
};

const DEFAULT_MAX_JOBS_PER_TERM = 25;

function isScavioSource(value: string): value is ScavioSource {
  return value === "scavio_linkedin" || value === "scavio_indeed";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toProgress(
  source: ScavioSource,
  event: ScavioProgressEvent,
): ExtractorProgressEvent {
  const complete = event.type === "term_complete";
  return {
    phase: "list",
    termsProcessed: complete ? event.termIndex : event.termIndex - 1,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: complete ? event.jobsFoundTerm : undefined,
    jobPagesProcessed: complete ? event.jobsFoundTerm : undefined,
    detail: complete
      ? `${SOURCE_LABELS[source]}: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm ?? 0} jobs`
      : `${SOURCE_LABELS[source]}: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
  };
}

export const manifest: ExtractorManifest = {
  id: "scavio",
  displayName: "Scavio",
  providesSources: ["scavio_linkedin", "scavio_indeed"],
  requiredEnvVars: ["SCAVIO_API_KEY"],
  locationCapabilities: {
    scavio_linkedin: { supportedCountryKeys: null },
    scavio_indeed: { supportedCountryKeys: ["united states"] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    // Workspace settings win over the process env, which is shared by tenants.
    const apiKey =
      context.settings.scavioApiKey?.trim() ||
      process.env.SCAVIO_API_KEY?.trim();
    if (!apiKey) {
      return {
        success: false,
        jobs: [],
        error: "Missing Scavio API key (SCAVIO_API_KEY)",
      };
    }

    // Every result costs credits, so the per-term cap is the smaller of the
    // Scavio ceiling and the run's shared result budget.
    const ceiling =
      parsePositiveInt(process.env.SCAVIO_MAX_JOBS_PER_TERM) ??
      DEFAULT_MAX_JOBS_PER_TERM;
    const sharedBudget = parsePositiveInt(context.settings.jobspyResultsWanted);
    const maxJobsPerTerm = Math.min(ceiling, sharedBudget ?? ceiling);

    const sources = (
      context.selectedSources.length > 0
        ? context.selectedSources
        : [context.source]
    ).filter(isScavioSource);
    const locations = resolveSearchCities({
      list: context.sourceLocationPlan?.requestedCities,
      single: context.settings.searchCities ?? context.settings.jobspyLocation,
    });

    const jobs: CreateJobInput[] = [];
    const sourceErrors: string[] = [];
    for (const source of sources) {
      if (context.shouldCancel?.()) break;

      const result = await runScavio({
        source,
        apiKey,
        searchTerms: context.searchTerms,
        selectedCountry: context.selectedCountry,
        locations,
        maxJobsPerTerm,
        fetchLinkedinDescriptions:
          process.env.SCAVIO_LINKEDIN_FETCH_DESCRIPTION === "true",
        shouldCancel: context.shouldCancel,
        onProgress: (event) => {
          if (!context.shouldCancel?.())
            context.onProgress?.(toProgress(source, event));
        },
      });
      jobs.push(...result.jobs);
      if (!result.success) {
        sourceErrors.push(`${source}: ${result.error ?? "unknown error"}`);
      }
    }

    // A failed result discards its jobs, so only fail when nothing came back:
    // jobs found before a mid-run error (e.g. out of credits) were already paid for.
    if (jobs.length === 0 && sourceErrors.length === sources.length) {
      return { success: false, jobs, error: sourceErrors.join("; ") };
    }
    return sourceErrors.length > 0
      ? { success: true, jobs, sourceErrors }
      : { success: true, jobs };
  },
};

export default manifest;

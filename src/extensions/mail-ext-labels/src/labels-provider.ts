import type {
  ExtensionContext,
  EnrichmentProvider,
  EnrichmentData,
} from "../../../shared/extension-types";
import type { DashboardEmail } from "../../../shared/types";

/**
 * Labels enrichment provider — registered to keep the sidebar panel active,
 * but returns null for enrichment data. The LabelsPanel component resolves
 * labels directly via window.api.labels to avoid the sender-scoped enrichment
 * cache (which would serve stale labels across different emails from the same sender).
 */
export function createLabelsProvider(_context: ExtensionContext): EnrichmentProvider {
  return {
    id: "labels-provider",
    panelId: "email-labels",
    priority: 90,

    canEnrich(): boolean {
      return true;
    },

    async enrich(_email: DashboardEmail): Promise<EnrichmentData | null> {
      // Labels are resolved directly in LabelsPanel via window.api.labels
      // to avoid sender-scoped enrichment cache returning wrong labels.
      return null;
    },
  };
}

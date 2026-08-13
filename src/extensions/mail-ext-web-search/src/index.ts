import type {
  ExtensionContext,
  ExtensionAPI,
  ExtensionModule,
} from "../../../shared/extension-types";
import {
  getFeatureModelConfig,
  getModelIdForFeature,
  getSenderLookupConfig,
} from "../../../main/ipc/settings.ipc";
import { createWebSearchProvider } from "./web-search-provider";

/**
 * Web Search Extension for Mail Client
 * Looks up sender information using web search
 */
const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating web-search extension");

    // Register the enrichment provider.
    // Settings resolvers are injected here (entry point) rather than deep in the
    // provider, keeping the provider decoupled from Electron main-process internals.
    // - getModelId: model for the Anthropic web_search path (provider==="anthropic")
    // - getSearchConfig: which search backend + Exa key
    // - getParsingModelConfig: provider+model for the LLM that parses Exa results
    //   (so users can route the parsing step through Ollama if they want)
    const provider = createWebSearchProvider(context, {
      getModelId: () => getModelIdForFeature("senderLookup"),
      getSearchConfig: () => getSenderLookupConfig(),
      getParsingModelConfig: () => getFeatureModelConfig("senderLookup"),
    });
    api.registerEnrichmentProvider(provider);

    context.logger.info("Web-search extension activated");
  },

  async deactivate(): Promise<void> {
    console.log("[Ext:web-search] Deactivated");
  },
};

export const { activate, deactivate } = extension;

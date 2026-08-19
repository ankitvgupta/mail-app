/**
 * Bundled Extensions Registration
 *
 * This module registers all bundled extension panel components
 * with the extension UI system.
 */
import { registerPanelComponent } from "../ExtensionPanelSlot";
import { SenderProfilePanel } from "./SenderProfilePanel";
import { CalendarPanel } from "../../../extensions/mail-ext-calendar/src/renderer/CalendarPanel";
import { LabelsPanel } from "./LabelsPanel";
import { registerPrivateExtensions } from "../private-extensions";
import { loadInstalledExtensionPanels } from "../installed-extensions";

/**
 * Register all bundled extension panel components
 * Called during app initialization
 */
export function registerBundledExtensions(): void {
  // Register web-search extension's sender profile panel
  registerPanelComponent("web-search", "sender-profile", SenderProfilePanel);

  // Register calendar extension's day-view panel
  registerPanelComponent("calendar", "day-view", CalendarPanel);

  // Register labels extension's panel
  registerPanelComponent("labels", "email-labels", LabelsPanel);

  // Register private extension panels (loaded from extensions-private/)
  registerPrivateExtensions();

  // Load installed extension panels asynchronously (runtime discovery)
  loadInstalledExtensionPanels().catch((err) => {
    console.warn("[Extensions] Failed to load installed extension panels:", err);
  });

  console.log("[Extensions] Registered bundled extension components");
}

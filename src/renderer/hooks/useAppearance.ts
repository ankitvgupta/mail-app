import { useEffect } from "react";
import { useAppStore } from "../store";
import { THEME_PRESETS, FONT_SCALE_VALUES } from "../../shared/theme-presets";
import type { AppearanceConfig } from "../../shared/types";
import type { ThemeColors } from "../../shared/theme-presets";

// Convert "#2563eb" → "37 99 235"
function hexToRgbTriplet(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Lighten or darken an RGB triplet by a factor (-1 to 1)
function adjustBrightness(triplet: string, factor: number): string {
  const [r, g, b] = triplet.split(" ").map(Number);
  const adjust = (c: number) =>
    Math.min(255, Math.max(0, Math.round(factor > 0 ? c + (255 - c) * factor : c * (1 + factor))));
  return `${adjust(r)} ${adjust(g)} ${adjust(b)}`;
}

// Apply the full set of CSS variables to <html>
function applyThemeVariables(appearance: AppearanceConfig, isDark: boolean): void {
  const preset = THEME_PRESETS[appearance.themePreset] ?? THEME_PRESETS.default;
  const colors: ThemeColors = isDark ? preset.dark : preset.light;
  const root = document.documentElement;

  // Surface & text colors from preset
  root.style.setProperty("--bg-base", colors.bgBase);
  root.style.setProperty("--bg-surface", colors.bgSurface);
  root.style.setProperty("--bg-elevated", colors.bgElevated);
  root.style.setProperty("--border-default", colors.borderDefault);
  root.style.setProperty("--text-primary", colors.textPrimary);
  root.style.setProperty("--text-secondary", colors.textSecondary);

  // Accent — custom color overrides the preset
  if (appearance.accentColor) {
    const rgb = hexToRgbTriplet(appearance.accentColor);
    root.style.setProperty("--accent", rgb);
    root.style.setProperty("--accent-hover", adjustBrightness(rgb, isDark ? 0.25 : -0.15));
    root.style.setProperty("--accent-soft", adjustBrightness(rgb, isDark ? -0.6 : 0.7));
  } else {
    root.style.setProperty("--accent", colors.accent);
    root.style.setProperty("--accent-hover", colors.accentHover);
    root.style.setProperty("--accent-soft", colors.accentSoft);
  }

  // Transparency — slider value (0 = opaque, 100 = fully transparent)
  // When vibrancy is on, use at least 20% transparency so desktop blur shows through
  const transparencyPct = appearance.transparency ?? 0;
  const effectivePct = appearance.vibrancy ? Math.max(transparencyPct, 20) : transparencyPct;
  const alpha = effectivePct > 0 ? Math.max(0.1, 1 - effectivePct / 100) : 1;
  root.style.setProperty("--bg-alpha", String(alpha));

  // Vibrancy — make base layer transparent so OS blur shows through
  if (appearance.vibrancy) {
    root.classList.add("has-vibrancy");
  } else {
    root.classList.remove("has-vibrancy");
  }

  // Background gradient — rendered behind the semi-transparent surfaces
  if (appearance.backgroundGradient) {
    root.style.setProperty("--bg-gradient", appearance.backgroundGradient);
    root.classList.add("has-gradient");
  } else {
    root.style.removeProperty("--bg-gradient");
    root.classList.remove("has-gradient");
  }

  // Font scale
  const scale = FONT_SCALE_VALUES[appearance.fontScale] ?? 1;
  root.style.setProperty("--font-scale", String(scale));
}

/**
 * Reads appearance config from the store, applies CSS variables to <html>,
 * and listens for changes from the main process.
 */
export function useAppearance(): void {
  const appearance = useAppStore((s) => s.appearance);
  const setAppearance = useAppStore((s) => s.setAppearance);
  const resolvedTheme = useAppStore((s) => s.resolvedTheme);

  // Fetch persisted config on mount
  useEffect(() => {
    window.api.appearance.get().then((result: { success: boolean; data?: AppearanceConfig }) => {
      if (result.success && result.data) {
        setAppearance(result.data);
      }
    });

    // Listen for changes broadcast from main process (e.g. from another window)
    window.api.appearance.onChange((data: Record<string, unknown>) => {
      setAppearance(data as AppearanceConfig);
    });

    return () => {
      window.api.appearance.removeAllListeners();
    };
  }, [setAppearance]);

  // Re-apply CSS variables whenever appearance config or resolved theme changes
  useEffect(() => {
    applyThemeVariables(appearance, resolvedTheme === "dark");
  }, [appearance, resolvedTheme]);
}

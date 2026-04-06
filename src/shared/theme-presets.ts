import type { ThemePresetId } from "./types";

// All color values are space-separated RGB triplets for use with rgb() / rgba()
export interface ThemeColors {
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  borderDefault: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
}

export interface ThemePreset {
  id: ThemePresetId;
  name: string;
  light: ThemeColors;
  dark: ThemeColors;

  // Preview colors for the settings UI swatch
  preview: { surface: string; accent: string };
}

// Default — matches the current Tailwind gray/blue palette exactly
const DEFAULT_PRESET: ThemePreset = {
  id: "default",
  name: "Default",
  preview: { surface: "#f3f4f6", accent: "#2563eb" },
  light: {
    bgBase: "243 244 246",
    bgSurface: "255 255 255",
    bgElevated: "255 255 255",
    borderDefault: "229 231 235",
    textPrimary: "17 24 39",
    textSecondary: "75 85 99",
    accent: "37 99 235",
    accentHover: "29 78 216",
    accentSoft: "219 234 254",
  },
  dark: {
    bgBase: "17 24 39",
    bgSurface: "31 41 55",
    bgElevated: "55 65 81",
    borderDefault: "55 65 81",
    textPrimary: "243 244 246",
    textSecondary: "156 163 175",
    accent: "59 130 246",
    accentHover: "96 165 250",
    accentSoft: "30 58 138",
  },
};

// Midnight — deep navy surfaces, violet accent
const MIDNIGHT_PRESET: ThemePreset = {
  id: "midnight",
  name: "Midnight",
  preview: { surface: "#0f172a", accent: "#8b5cf6" },
  light: {
    bgBase: "241 245 249",
    bgSurface: "248 250 252",
    bgElevated: "255 255 255",
    borderDefault: "226 232 240",
    textPrimary: "15 23 42",
    textSecondary: "71 85 105",
    accent: "139 92 246",
    accentHover: "124 58 237",
    accentSoft: "237 233 254",
  },
  dark: {
    bgBase: "15 23 42",
    bgSurface: "30 41 59",
    bgElevated: "51 65 85",
    borderDefault: "51 65 85",
    textPrimary: "241 245 249",
    textSecondary: "148 163 184",
    accent: "139 92 246",
    accentHover: "167 139 250",
    accentSoft: "76 29 149",
  },
};

// Nord — polar night surfaces, frost blue accent
const NORD_PRESET: ThemePreset = {
  id: "nord",
  name: "Nord",
  preview: { surface: "#2e3440", accent: "#88c0d0" },
  light: {
    bgBase: "236 239 244",
    bgSurface: "242 244 248",
    bgElevated: "255 255 255",
    borderDefault: "216 222 233",
    textPrimary: "46 52 64",
    textSecondary: "76 86 106",
    accent: "94 129 172",
    accentHover: "76 108 148",
    accentSoft: "222 233 244",
  },
  dark: {
    bgBase: "46 52 64",
    bgSurface: "59 66 82",
    bgElevated: "67 76 94",
    borderDefault: "67 76 94",
    textPrimary: "236 239 244",
    textSecondary: "216 222 233",
    accent: "136 192 208",
    accentHover: "143 188 187",
    accentSoft: "59 80 97",
  },
};

// Solarized — warm base tones, yellow accent
const SOLARIZED_PRESET: ThemePreset = {
  id: "solarized",
  name: "Solarized",
  preview: { surface: "#002b36", accent: "#b58900" },
  light: {
    bgBase: "238 232 213",
    bgSurface: "253 246 227",
    bgElevated: "255 255 255",
    borderDefault: "220 213 194",
    textPrimary: "0 43 54",
    textSecondary: "88 110 117",
    accent: "181 137 0",
    accentHover: "152 115 0",
    accentSoft: "248 237 196",
  },
  dark: {
    bgBase: "0 43 54",
    bgSurface: "7 54 66",
    bgElevated: "29 78 89",
    borderDefault: "29 78 89",
    textPrimary: "238 232 213",
    textSecondary: "147 161 161",
    accent: "181 137 0",
    accentHover: "209 166 41",
    accentSoft: "60 52 12",
  },
};

// Rose — warm surfaces, pink accent
const ROSE_PRESET: ThemePreset = {
  id: "rose",
  name: "Rose",
  preview: { surface: "#1c1017", accent: "#f43f5e" },
  light: {
    bgBase: "255 241 242",
    bgSurface: "255 255 255",
    bgElevated: "255 255 255",
    borderDefault: "252 231 233",
    textPrimary: "28 16 23",
    textSecondary: "113 63 79",
    accent: "244 63 94",
    accentHover: "225 29 72",
    accentSoft: "255 228 230",
  },
  dark: {
    bgBase: "28 16 23",
    bgSurface: "44 24 36",
    bgElevated: "64 36 52",
    borderDefault: "64 36 52",
    textPrimary: "255 241 242",
    textSecondary: "194 153 168",
    accent: "251 113 133",
    accentHover: "253 164 175",
    accentSoft: "100 20 44",
  },
};

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  default: DEFAULT_PRESET,
  midnight: MIDNIGHT_PRESET,
  nord: NORD_PRESET,
  solarized: SOLARIZED_PRESET,
  rose: ROSE_PRESET,
};

export const THEME_PRESET_LIST: ThemePreset[] = Object.values(THEME_PRESETS);

// Accent color swatches for the picker UI
export const ACCENT_SWATCHES = [
  { name: "Blue", hex: "#2563eb", rgb: "37 99 235" },
  { name: "Violet", hex: "#7c3aed", rgb: "124 58 237" },
  { name: "Pink", hex: "#db2777", rgb: "219 39 119" },
  { name: "Rose", hex: "#f43f5e", rgb: "244 63 94" },
  { name: "Orange", hex: "#ea580c", rgb: "234 88 12" },
  { name: "Green", hex: "#16a34a", rgb: "22 163 74" },
  { name: "Teal", hex: "#0d9488", rgb: "13 148 136" },
  { name: "Cyan", hex: "#0891b2", rgb: "8 145 178" },
] as const;

// Background gradient presets
export const GRADIENT_PRESETS = [
  {
    id: "aurora",
    name: "Aurora",
    css: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 30%, #155e75 50%, #134e4a 70%, #0f172a 100%)",
  },
  {
    id: "sunset",
    name: "Sunset",
    css: "linear-gradient(135deg, #1a1a2e 0%, #16213e 25%, #5e2563 50%, #c2185b 75%, #ff6f00 100%)",
  },
  {
    id: "ocean",
    name: "Ocean",
    css: "linear-gradient(180deg, #0a1628 0%, #0d2847 30%, #0e4d64 60%, #0a1628 100%)",
  },
  {
    id: "ember",
    name: "Ember",
    css: "linear-gradient(135deg, #1a0a0a 0%, #3d1212 30%, #7c2d12 55%, #451a03 80%, #1a0a0a 100%)",
  },
  {
    id: "lavender",
    name: "Lavender",
    css: "linear-gradient(135deg, #1e1b2e 0%, #2d2252 30%, #4c1d95 55%, #2d2252 80%, #1e1b2e 100%)",
  },
  {
    id: "forest",
    name: "Forest",
    css: "linear-gradient(180deg, #0a1a0a 0%, #14352a 30%, #1a4731 55%, #0f2318 80%, #0a1a0a 100%)",
  },
  {
    id: "cosmic",
    name: "Cosmic",
    css: "linear-gradient(135deg, #0f0c29 0%, #302b63 40%, #24243e 70%, #0f0c29 100%)",
  },
  {
    id: "rose-gold",
    name: "Rose Gold",
    css: "linear-gradient(135deg, #1c1017 0%, #3b1a2b 30%, #6b3a4a 50%, #b76e79 75%, #3b1a2b 100%)",
  },
] as const;

// Font scale multipliers
export const FONT_SCALE_VALUES = {
  small: 0.875,
  default: 1,
  large: 1.125,
} as const;

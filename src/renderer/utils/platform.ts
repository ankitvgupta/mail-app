export function isMacPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
) {
  return platform.toLowerCase().includes("mac");
}

export function formatPlatformShortcut(
  key: string | number,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return isMacPlatform(platform) ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * macOS apps commonly stay resident after their last window is closed. Exo's
 * renderer owns navigation state and its cached inbox, so destroying that last
 * window turns the next Dock activation into an avoidable cold start.
 */
export function shouldHideWindowOnClose(platform: NodeJS.Platform, isQuitting: boolean): boolean {
  return platform === "darwin" && !isQuitting;
}

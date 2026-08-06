import { isAbsolute } from "path";

/**
 * EXO_USER_DATA_DIR: explicit absolute-path override for the app data dir,
 * honored in ALL modes including packaged builds. Exists so packaged smoke
 * tests (tests/packaged/) never share the real install's data dir — a
 * locally-built .app has the same productName as the real install, so
 * without the override it would read and write production data.
 *
 * Kept as a leaf module (no imports beyond path) so both data-dir.ts and
 * logger.ts resolve the override identically without creating an import
 * cycle (logger is imported at module scope elsewhere in main).
 */
export function getUserDataOverride(): string | null {
  const override = process.env.EXO_USER_DATA_DIR;
  if (!override) return null;
  if (!isAbsolute(override)) {
    throw new Error(`EXO_USER_DATA_DIR must be an absolute path, got: ${override}`);
  }
  return override;
}

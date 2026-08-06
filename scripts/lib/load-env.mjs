import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal .env loader shared by the local minimax/Ollama test + benchmark
 * scripts. Parses `KEY=VALUE` lines (optional surrounding double-quotes,
 * `#` comments) and does NOT overwrite keys already present in process.env,
 * so an explicit `OLLAMA_API_KEY=… node script.mjs` still wins.
 */
export function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq);
    let val = t.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

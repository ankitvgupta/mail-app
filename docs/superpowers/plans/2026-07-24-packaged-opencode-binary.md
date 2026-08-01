# Packaged OpenCode Binary Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the packaged macOS Exo app discover its bundled OpenCode executable so enabled OpenCode settings produce an OpenCode option in the agent picker.

**Architecture:** Reuse the platform-package executable electron-builder already preserves beneath `process.resourcesPath`, choosing the compatibility-safe baseline variant on x64. Resolve that path directly in the utility-process worker, then cover PATH lookup, executability, and provider availability with unit and packaged smoke tests.

**Tech Stack:** Electron, TypeScript, Node.js filesystem/module resolution, Playwright.

## Global Constraints

- Preserve the existing development resolution paths and memoization.
- Do not read or modify the production Exo profile during tests.
- Use Node.js `22.22.0` for install, tests, and packaging.
- Keep the PR limited to OpenCode binary packaging, its regression coverage, and this plan.

---

### Task 1: Resolve the existing packaged OpenCode executable

**Files:**

- Modify: `src/main/agents/providers/opencode/opencode-agent-provider.ts`
- Modify: `tests/unit/opencode-binary-resolution.spec.ts`

**Interfaces:**

- Consumes: the executable already shipped by the platform-specific optional dependency.
- Produces: its direct `app.asar.unpacked/node_modules/opencode-<platform>-<arch>[-baseline]/bin/opencode[.exe]` path.

- [ ] **Step 1: Prove the canonical shim is absent from the pre-fix bundle**

Inspect `Contents/Resources/app.asar` and `app.asar.unpacked`. Expected: `opencode-ai/package.json` is present, but `opencode-ai/bin/opencode.exe` is absent.

- [ ] **Step 2: Resolve the existing platform binary**

Resolve the platform dependency beneath `process.resourcesPath`, using the baseline package on x64 so distributables do not inherit the build runner's AVX2 capability. Preserve the normal package-resolution fallback for development.

- [ ] **Step 3: Keep resolver documentation current**

Document the packaged and development paths and keep the resolver memoized.

### Task 2: Prove the packaged artifact

**Files:**

- Modify: `tests/packaged/smoke.spec.ts`

**Interfaces:**

- Consumes: `EXO_PACKAGED_BINARY` pointing to the packaged executable.
- Produces: smoke assertions that the platform executable is present and executable and that enabled OpenCode appears in the packaged agent picker after restart.

- [ ] **Step 1: Add the packaged smoke assertion**

Derive the platform package's unpacked `bin` directory from the packaged executable, assert the platform SDK command exists, invoke `opencode --version` through the production PATH lookup, and assert POSIX execute bits are non-zero where applicable.

Persist enabled OpenCode settings in the smoke suite's isolated profile, restart that packaged app, open the agent palette, and assert the `OpenCode` provider button is visible.

- [ ] **Step 2: Build and package**

Run: `npm run build`

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`

- [ ] **Step 3: Run the packaged smoke suite**

Run: `EXO_PACKAGED_BINARY=release/mac-arm64/Exo.app/Contents/MacOS/Exo npx playwright test --project=packaged`

Expected: all packaged smoke tests pass without touching `~/Library/Application Support/exo`.

### Task 3: Validate and publish the draft PR

**Files:**

- Review all changed files from Tasks 1 and 2.

**Interfaces:**

- Consumes: the green fix branch.
- Produces: a pushed branch and draft PR against `ankitvgupta/exo:main`.

- [ ] **Step 1: Run local gates**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run format:check`

Run: `npm test`

- [ ] **Step 2: Commit and push**

Stage only the plan, resolver, unit coverage, and packaged smoke test. Commit as `Fix packaged OpenCode binary resolution`, then push `codex/fix-packaged-opencode-binary` to `upstream-pr`.

- [ ] **Step 3: Open the draft PR**

Create a draft PR against `ankitvgupta/exo:main` with root cause, impact, and exact validation commands.

- [ ] **Step 4: Run required post-PR gates**

Run full `npm run pre-pr`, then `/review`, `/reviewloop`, and `gh pr checks`. Fix major findings and rerun required gates until the PR is clean or an external credential/CI blocker is proven.

### Task 4: Build and install the all-PR integration app

**Files:**

- No source edits beyond merge conflict resolution in a dedicated integration worktree.

**Interfaces:**

- Consumes: current `upstream/main`, PR heads #169, #170, #171, #180, #190, and the new OpenCode fix PR head.
- Produces: a packaged and installed `/Applications/Exo.app` using the unchanged production profile.

- [ ] **Step 1: Create the integration worktree and merge authoritative PR heads**

Create a fresh integration branch from current `upstream/main`. Merge each Mick-authored open PR head and the new fix head, preserving all feature behavior during conflict resolution.

- [ ] **Step 2: Install, build, test, and package**

Use Node.js `22.22.0`, run `npm install`, focused conflict-area tests, `npm run build`, and `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`.

- [ ] **Step 3: Install safely**

Preserve a rollback copy of `/Applications/Exo.app`, replace only the app bundle, and leave `~/Library/Application Support/exo` untouched.

- [ ] **Step 4: Verify installed provenance and behavior**

Compare packaged and installed `app.asar` SHA-256 values, confirm the live process runs `/Applications/Exo.app` with the production profile, and confirm the OpenCode provider appears after `Cmd+J`.

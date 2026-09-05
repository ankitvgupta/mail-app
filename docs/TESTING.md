# Testing

## Framework

All tests use [Playwright Test](https://playwright.dev/) as the test runner (not Jest or Vitest). Configuration is in `playwright.config.ts`.

## Test Projects

| Project | Directory | What it tests | Parallelism |
|---------|-----------|---------------|-------------|
| `unit` | `tests/unit/` | Services, utilities, pure logic | Fully parallel |
| `e2e` | `tests/e2e/` | Full Electron app (launch, click, verify) | Parallel across files, serial within describe blocks |
| `integration` | `tests/*.spec.ts` (root) | Cross-module integration without Electron | Fully parallel |
| `problematic` | `tests/problematic/` | Flaky or incomplete feature tests | Serial, 1 worker |

## Running Tests

For measurements against large synthetic mailboxes using the production database and Electron UI, see [the performance audit](./PERFORMANCE_AUDIT.md). Run `npm run perf:audit -- 10000 50000` with the native SQLite addon built for system Node; no Gmail or AI credentials are needed.

```bash
npm test                    # All tests (unit + e2e + integration)
npm run test:unit           # Unit tests only
npm run test:e2e            # E2E tests only
npm run test:integration    # Integration tests only
npm run test:problematic    # Flaky/incomplete tests (debugging only)
npm run test:quick          # Unit + integration (no Electron launch)
```

## The `run-tests.sh` Script

`scripts/run-tests.sh` handles the better-sqlite3 ABI compatibility problem. The native module must be compiled for the right Node version:

- **System Node** (ABI 127): Required for unit tests
- **Electron's Node** (ABI 132): Required for e2e and integration tests

The script:
1. Runs integration + e2e first (Electron-compiled better-sqlite3, often already correct from `npm ci`)
2. Rebuilds better-sqlite3 for system Node
3. Runs unit tests
4. Cleans up per-worker test databases

On macOS, Electron tests run natively (Quartz). On Linux, the script uses `xvfb-run` for headless display.

## Worker Isolation

E2E tests run in parallel. Each Playwright worker gets an isolated database via `TEST_WORKER_INDEX`:
- Database filename: `gmail-drafter-demo-w{index}.db`
- Set by Playwright's `testInfo.parallelIndex` and passed to the Electron process
- Cleaned up before and after test runs by `run-tests.sh`

## Test Modes

| Mode | Env Var | Purpose |
|------|---------|---------|
| Demo | `GMAIL_DRAFTER_DEMO_MODE=true` | Mock data, no real API calls. Used by all automated tests. |
| Test | `GMAIL_DRAFTER_TEST_MODE=true` | Similar to demo but for manual test scenarios. |
| Real | Neither set | Real Gmail + Claude API calls. Never used in CI. |

## Mocking Patterns

### AnthropicService Mock (`tests/mocks/anthropic-api-mock.ts`)

For unit-testing services that call Claude through `AnthropicService`:

```typescript
import {
  mockAnthropicResponse,
  queueAnthropicResponses,
  resetAnthropicMock,
  MockAnthropic,
} from "../mocks/anthropic-api-mock";
import { _setClientForTesting } from "../../src/main/services/anthropic-service";

// In test setup:
_setClientForTesting(new MockAnthropic());
mockAnthropicResponse({ text: '{"needs_reply": true, "reason": "question", "priority": "high"}' });

// In teardown:
resetAnthropicMock();
_setClientForTesting(null);
```

Key features:
- `mockAnthropicResponse()` — set a single canned response for all calls
- `queueAnthropicResponses()` — queue ordered responses consumed per call
- `mockAnthropicError()` — queue an error to throw on next call
- `getCapturedRequests()` — inspect what was sent to Claude

### Gmail API Fixtures (`tests/mocks/gmail-api-fixtures.ts`)

Static email data for tests that don't need real Gmail API responses.

### Mock Gmail Client (`tests/mocks/mock-gmail-client.ts`)

Replaces `GmailClient` for testing sync and email-related services.

## What's in `tests/problematic/`

Tests excluded from the main suite because they:
- Have timing sensitivity or state isolation issues (e.g., `archive-flaky.spec.ts`)
- Test features not fully implemented in demo mode (e.g., `body-mention-autocomplete.spec.ts`)
- Require specific UI state that's hard to set up reliably in CI

Run them with `npm run test:problematic` when debugging those features.

## Adding New Tests

1. **Unit tests**: Create `tests/unit/<feature>.spec.ts`. Import services directly, mock external dependencies.
2. **E2E tests**: Create `tests/e2e/<feature>.spec.ts`. Use `launch-helpers.ts` to start the Electron app.
3. **Integration tests**: Create `tests/<feature>.spec.ts` at the tests root.
4. Name files `*.spec.ts` (required by Playwright's `testMatch` pattern).
5. For services that use Claude, use the `MockAnthropic` + `_setClientForTesting()` pattern described above.
6. For services that use the database, create a fresh in-memory database in your test setup.

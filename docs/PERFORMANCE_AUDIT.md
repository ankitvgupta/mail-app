# Performance audit — September 2026

The main bottleneck was local search: SQLite started from every email in an account and repeatedly probed FTS for each row. On the larger synthetic mailbox this blocked the main process for roughly 35 seconds per common search. Inbox refresh also repeatedly read and regrouped archived mail, even when the visible inbox had not grown.

## Measured results

Measurements use production database functions and the real SQLite schema, with email bodies from `src/main/demo/fake-inbox.ts`. Each disposable, on-disk mailbox contains two accounts with equal amounts of history. Search targets one account; its inbox returns 1,000 messages, including sent conversation context. The total mailbox size increases while the visible inbox stays fixed.

Baseline: commit `e9b5aec`. Environment: Amazon Linux x86_64, Node 24.13.0, bundled better-sqlite3. Times are warm medians, excluding fixture setup. Each operation has a warmup and nine samples; baseline operations exceeding 200 ms use three samples to keep the run tractable. These are local measurements, not Gmail network timings or a claim about every user's hardware.

| Operation | 10,000 emails before → after | 50,000 emails before → after |
| --- | ---: | ---: |
| Common search, 20 results | 1,829 → 4.3 ms | 35,475 → 42.8 ms |
| Selective search | 99.5 → 0.75 ms | 1,562 → 3.1 ms |
| Substring fallback | 38.4 → 1.5 ms | 231 → 19.3 ms |
| Search with no matches | 38.6 → 3.0 ms | 244 → 25.7 ms |
| Refresh 1,000 inbox/context messages | 16.2 → 4.4 ms | 78.0 → 5.1 ms |
| Full local search, 500 results | 1,881 → 9.5 ms | 35,077 → 48.7 ms |
| 100 label updates in a transaction | 8.1 → 1.8 ms | 7.6 → 1.7 ms |

The 500-result payload fell from 388,663 to 206,663 bytes on the larger fixture (47% smaller). Bodies remain available through the existing message/thread detail APIs. Real HTML-heavy mailboxes may have a different payload reduction.

The Electron test injects 20,000 inbox messages across two accounts, uses the actual account menu and refresh IPC flow, and verifies keyboard navigation, search, and fewer than 100 mounted thread rows. With immediate fixture responses, the median account switch was approximately 194 ms before and 138 ms after. Measurements disable headless background-frame throttling and bypass Playwright's button stability waits; they include waiting for the destination rows to become visible. The baseline's redundant Gmail fetch also returned immediately, so this does not measure the additional network delay removed from real account switches.

## Renderer and multi-account follow-up

The second pass profiles the built Electron renderer. A 30,000-message inbox (10,000 conversations) exercises refreshes, individual body updates, and a 1,500-result search. CDP CPU profiles identified thread reconstruction, date formatting, HTML entity decoding, and mounting every search row as the remaining major costs.

Measurements run inside the renderer from the action through a frame's render opportunity, avoiding Playwright polling overhead. The benchmark explicitly shows/focuses the window, disables background throttling, and enables CDP focus emulation. Without focus emulation this VM throttles animation frames to roughly one second; those preliminary timings are excluded. Fixtures and structured-clone preparation are outside the timed actions. Long-task logs also include fixture preparation and must not be interpreted as exclusively application work.

| Interaction | Before renderer changes | After |
| --- | ---: | ---: |
| Display 1,500 search results (first display) | 512 ms | 25 ms |
| Move selection through search (median, 6 actions) | 233 ms | 18 ms |
| Update one message body in 30,000 messages (median, 8 actions) | 42 ms | 17 ms |
| Reconcile unchanged 30,000-message metadata (median, 8 actions) | 54 ms | 33 ms |
| Mounted search rows | 1,500 | 66 |

A separate account-menu test contains **60,000 inbox messages across three accounts**, with real IPC transport carrying account refreshes and body batches. It switches among all three accounts and All Inboxes ten times. Its before measurement already includes the search/rendering changes above; it isolates the subsequent account caching and paint scheduling changes.

| Account interaction | Before account changes | After |
| --- | ---: | ---: |
| Return to a visited account (median, 6 switches) | 36 ms | 18 ms |
| First All Inboxes display | 464 ms | 73 ms |
| Return to All Inboxes | 402 ms | 23 ms |

Cold first visits to individual accounts remain around 51 ms in this extreme fixture: they must build that account's conversation index once. Warm switching uses cached conversation objects. These measurements describe local responsiveness with immediate fake server responses, not live Gmail network speed.

The accelerated churn test performs **120 account refresh/switch cycles**, replaces **12,000 messages**, and keeps the total at 30,000 messages. Forced-GC renderer heap samples were approximately 34.5, 36.3, 37.7, 39.4, 41.1, and 42.9 MiB. The live dataset deliberately gains message bodies throughout the run; growth stayed within the test's allowance without accumulating another mailbox snapshot on each switch. This is a short stress test, not a multi-hour leak certification.

The fixtures, CPU profiles, and raw measurement logs from this run are in the gitignored `.context` directory; the reproducible test files are included with the code.

## Changes

- Make FTS the outer loop with `CROSS JOIN`, then retrieve matching email rows by rowid. Preserve relevance ordering, date tie-breaking, account filtering, limits, and offsets. Quote punctuation in address searches so normal email addresses do not fall through to a failed full scan. SQLite documents this join-order control in its [query optimizer overview](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join).
- Add a partial inbox index. Reuse account-scoped thread linkage until messages change and query sent context only for visible conversations. List and detail share canonical thread selection, including duplicate Message-IDs; inserts, replacements, deletes, account removal, and database replacement invalidate the cache. Label changes are read immediately without rebuilding linkage.
- Update existing email rows using UPSERT, preserving rowids. Reindex only when indexed text actually changes; read, star, archive, and other label changes no longer rewrite FTS. Migration 9 installs the index and replaces the old trigger on existing databases. It does not rebuild the entire search index.
- Send search metadata without bodies. Remote search checks only the returned IDs instead of loading every cached ID, saves newly fetched messages in one transaction, and requests 50 results on the first page for a single account. Existing pagination retrieves more; unified search retains its previous result limit.
- Remove the automatic legacy Gmail fetch on account changes. Cached inbox loading and background sync already handle that flow. Share threaded inbox derivation across mounted components and narrow search hook subscriptions. Ignore obsolete quick-search responses after typing a new query or clearing/closing search.

- Reconcile cloned metadata using structural sharing. Preserve loaded bodies, skip identical writes, and keep other accounts' arrays stable. Optimistic read/archive suppression remains in place.
- Cache conversation derivation per account and for All Inboxes. Rebuild only changed conversations, share split filtering and search grouping across consumers, and evict caches when accounts/inboxes are cleared. Sync updates to an inactive account do not invalidate the current account's derived view.
- Render the chosen account synchronously and let it paint before background refresh IPCs begin. The account title, visible list, and keyboard navigation now change together. Local refresh and Gmail sync still run on every account switch.
- Virtualize full search with stable row keys, selection scrolling, pagination, and restoration after opening a result. Reuse date formatters, skip entity decoding for plain text, remove selection color fades, and reduce quick-search debounce from 150 to 60 ms. Subsequent single-account Gmail pages now request 50 messages too.
- Limit bulk body prefetch to the newest 60 messages. After selection pauses for 75 ms, preload that conversation; React Query deduplicates the request with detail loading and retains unobserved results for 60 seconds (15-second freshness). Keying by account/thread prevents late responses from replacing another conversation. Cached bodies cannot overwrite current message metadata.
- Select that recent window explicitly from unordered database snapshots with one date parse per message and a bounded 60-item buffer. Missing cached conversation members must be verified by a new request before they can return to the store, so an archived/deleted message cannot be restored by an old prefetch result.
- Narrow detail-view subscriptions and unmount closed command/snooze overlays so unrelated background events do not keep doing hidden work.

## Reproduce

No credentials are needed:

```bash
npm rebuild better-sqlite3
NODE_ENV=production npx tsx scripts/perf-audit.ts 10000 50000
npx playwright test --project=unit mailbox-performance threaded-selector email-updates --workers=1
npx playwright test --project=migrations --workers=1

npm run ensure-native
npm run build
# On Linux, prefix with xvfb-run -a:
npx playwright test --project=e2e large-inbox inbox-responsiveness multi-account-performance thread-loading-performance virtualized-search search-request-races --workers=1
# Include a renderer CPU profile attachment in the test output:
EXO_PERF_PROFILE=1 npx playwright test --project=e2e inbox-responsiveness --workers=1
# Accelerated multi-account sync / memory churn:
npx playwright test --project=soak inbox-churn --workers=1
```

The native addon must match the runtime: database tests run in system Node; UI tests run in Electron. Do not rebuild or replace a native addon while another process is using it. The audit script optionally accepts `EXO_PERF_NATIVE_BINDING` pointing to a separate Node addon copy to keep those runtimes isolated.

The existing demo IPC handlers search a small canned inbox rather than the production FTS database. The new database tests therefore call production functions directly using the existing `_testSetDatabase` injection, and the Electron tests independently exercise rendering, switching, and search request ordering.

## Validation

- Build, application type checks, lint, formatting, and strict type checks of the new tests/audit script passed.
- Unit, migration, and existing benchmark projects: **1,557 passed**. Integration project: **18 passed** when run with the Electron native addon. An initial combined invocation used the Node addon for the Electron integration launch and failed that setup; rerunning integration with the correct runtime passed.
- The full **367-case Electron run** completed with **351 passed, 11 skipped, 3 not run, and 2 failed**, plus the existing **60-second worker teardown timeout** documented in `scripts/run-tests.sh`.
- Both failed assertions assumed keyboard navigation started on an email, but saved compose drafts from prior tests came first. Those suites now explicitly clear local drafts from their renderer fixture before testing email navigation. Both suites were rerun twice: **22 passed, 2 skipped**, clean exit. The previously failing checks and the three dependent navigation tests passed. This is a corrected focused rerun, not a claim that the original full-suite command exited successfully.
- The large-inbox, multi-account, search-race, virtualized-search/pagination, and thread-prefetch regression tests passed. They check bounded DOM and body prefetch, keyboard navigation, returning to an off-screen search result, page sizes, account refreshes, deduplicated thread fetches, and late-response isolation.
- The accelerated **120-cycle inbox churn test passed**, with forced-GC heap measurements and a stable 30,000-message store size.
- Production DB regressions cover query planning, search operators/account scoping, thread-cache invalidation, migrated triggers, FTS integrity after resync, and a conversation with **33,000 sent messages** that previously exceeded SQLite's bound-variable limit.
- Follow-up review found repeated expansion of merged Gmail thread groups during inbox refresh. Each group is now expanded once. A deterministic work-count regression covers a linked conversation plus sent context; a 10,000-message linked-inbox fixture improved from approximately 952 to 61 ms on warm refresh.
- PR security validation required updating Electron from 39.8.10 to 41.10.7 and fast-uri to 3.1.7. The performance measurements above precede that runtime update. The dependency changes remove the high-severity findings from the production audit; existing moderate-severity advisories remain.

## Limits and live Gmail validation

Warm inbox refresh no longer scales with archived history. A cache miss after mail insertion still builds linkage once for that account. FTS relevance ranking and the substring/no-match fallback still scale with matching content or mailbox size and run on the main process; these remain candidates for a search worker if much larger histories need it. The accelerated churn run does not establish multi-hour memory stability; live Gmail latency remains unmeasured. It prevents new stale FTS postings from replacement saves; it does not repair any already accumulated postings in an existing database.

Live smoke validation ran on macOS arm64 against the dedicated test Gmail account, with credentials kept on the Mac and app state isolated via `EXO_USER_DATA_DIR`. The Google profile check confirmed the expected account (43 messages), the app synced 33 inbox messages, and both local and remote Gmail search completed. Ten local search IPC samples had a 1.9 ms median and 5.8 ms maximum on this small inbox; this is a functional smoke check, not a large-mailbox performance measurement. Calendar sync reported that the Calendar API is disabled in the test OAuth project.

The current full-sync test needs repair before relying on it: it passes the unsupported `APP_DATA_DIR_OVERRIDE` variable and resolves the built app relative to the wrong directory. Use the supported `EXO_USER_DATA_DIR` and prime that isolated directory with test-account credentials before a future automated full-sync run.

If cloud-side live testing is later required, provide only `EXOEMAILTEST_EMAIL`, `EXOEMAILTEST_CLIENT_ID`, `EXOEMAILTEST_CLIENT_SECRET`, and `EXOEMAILTEST_REFRESH_TOKEN` through a secure file transfer into a gitignored `.env.local` with mode `600`. Do not paste a password, token, or the contents of a general-purpose `.env` into chat. The existing `.env.local.example` documents the expected fields.

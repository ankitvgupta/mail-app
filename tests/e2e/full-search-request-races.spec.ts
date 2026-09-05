import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { DashboardEmail } from "../../src/shared/types";
import type { useAppStore } from "../../src/renderer/store";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

const searchQuery = "shared query";

function email(id: string, accountId = "search-a"): DashboardEmail {
  return {
    id,
    accountId,
    threadId: `thread-${id}`,
    from: "Fixture Sender <sender@example.test>",
    to: "me@example.test",
    subject: id,
    body: "",
    date: "2026-01-01T00:00:00.000Z",
    labelIds: [],
  };
}

async function installSearchControls(app: ElectronApplication, page: Page) {
  await waitForEmailListReady(page);
  const controls = await app.evaluateHandle(({ ipcMain }) => {
    type Request = {
      accountId: string;
      query: string;
      pageToken?: string;
      resolve: (response: unknown) => void;
      reject: (error: Error) => void;
    };
    const requests: { local: Request[]; remote: Request[] } = { local: [], remote: [] };
    for (const [kind, channel] of [
      ["local", "emails:search"],
      ["remote", "emails:search-remote"],
    ] as const) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(
        channel,
        (_, input: { accountId: string; query: string; pageToken?: string }) =>
          new Promise((resolve, reject) => requests[kind].push({ ...input, resolve, reject })),
      );
    }
    for (const channel of ["search:query", "sync:get-emails", "sync:get-sent-emails"]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ success: true, data: [] }));
    }
    ipcMain.removeHandler("sync:now");
    ipcMain.handle("sync:now", () => ({ success: true }));
    return requests;
  });
  await page.evaluate(() => {
    const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
      .__ZUSTAND_STORE__;
    store.getState().clearActiveSearch();
    store.setState({
      emails: [],
      accounts: [
        { id: "search-a", email: "a@example.test", isPrimary: true, isConnected: true },
        { id: "search-b", email: "b@example.test", isPrimary: false, isConnected: true },
      ],
      currentAccountId: "search-a",
      currentSplitId: null,
      selectedEmailId: null,
      selectedThreadId: null,
      localDrafts: [],
      isOnline: true,
      viewMode: "split",
    });
  });
  return controls;
}

type SearchControls = Awaited<ReturnType<typeof installSearchControls>>;
type SearchResponse =
  | { emails: DashboardEmail[]; nextPageToken?: string }
  | { error: string; reject?: boolean };

async function resolveRequest(
  controls: SearchControls,
  kind: "local" | "remote",
  index: number,
  response: SearchResponse,
) {
  await controls.evaluate(
    (requests, { kind, index, response }) => {
      const request = requests[kind][index];
      if (!request) throw new Error(`Missing ${kind} request ${index}`);
      if ("error" in response) {
        if (response.reject) request.reject(new Error(response.error));
        else request.resolve({ success: false, error: response.error });
      } else {
        request.resolve({ success: true, data: kind === "local" ? response.emails : response });
      }
    },
    { kind, index, response },
  );
}

async function startSearch(page: Page) {
  await page.locator("button[title*='Search']").first().click();
  await page.locator("input[placeholder*='Search']").fill(searchQuery);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-results-header")).toContainText(searchQuery);
}

function readSearch(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
    ).__ZUSTAND_STORE__.getState();
    return {
      account: state.currentAccountId,
      query: state.activeSearchQuery,
      local: state.activeSearchResults.map((email) => email.id),
      remote: state.remoteSearchResults.map((email) => email.id),
      status: state.remoteSearchStatus,
      error: state.remoteSearchError,
      token: state.remoteSearchNextPageToken,
      loading: state.remoteSearchLoadingMore,
    };
  });
}

async function flushResponses(page: Page) {
  // Round-trip another IPC on the same renderer after releasing the old one,
  // then yield through its .then/.catch/.finally before asserting no change.
  await page.evaluate(async () => {
    await window.api.search.query("__response_barrier__");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function scrollSearchToBottom(page: Page) {
  await page
    .locator("button[data-thread-id]")
    .first()
    .evaluate((row) => {
      let element = row.parentElement;
      while (element && getComputedStyle(element).overflowY !== "auto")
        element = element.parentElement;
      if (!element) throw new Error("Missing search viewport");
      element.scrollTop = element.scrollHeight;
    });
}

test("same-text results from the previous account cannot overwrite the current account", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    const controls = await installSearchControls(app, page);
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([1, 1]);
    await page.getByRole("button", { name: "a@example.test", exact: true }).click();
    await page.getByRole("button", { name: "b@example.test", exact: true }).click();
    await expect(page.getByTestId("search-results-header")).toHaveCount(0);
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([2, 2]);
    expect(await controls.evaluate((r) => r.remote.map((request) => request.accountId))).toEqual([
      "search-a",
      "search-b",
    ]);
    await resolveRequest(controls, "local", 1, { emails: [email("current-local", "search-b")] });
    await resolveRequest(controls, "remote", 1, { emails: [email("current-remote", "search-b")] });
    await expect
      .poll(() => readSearch(page))
      .toMatchObject({
        account: "search-b",
        local: ["current-local"],
        remote: ["current-remote"],
        status: "complete",
      });
    await resolveRequest(controls, "local", 0, { emails: [email("obsolete-local")] });
    await resolveRequest(controls, "remote", 0, { emails: [email("obsolete-remote")] });
    await flushResponses(page);
    expect(await readSearch(page)).toMatchObject({
      account: "search-b",
      local: ["current-local"],
      remote: ["current-remote"],
      status: "complete",
      error: null,
    });
    await expect(page.getByText("current-local", { exact: true })).toBeVisible();
    await expect(page.getByText("obsolete-local", { exact: true })).toHaveCount(0);
    await controls.dispose();
  } finally {
    await closeApp(app);
  }
});

test("canceling and restarting the same query ignores old local results and remote errors", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    const controls = await installSearchControls(app, page);
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([1, 1]);
    await page.getByRole("button", { name: "Close search", exact: true }).click();
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([2, 2]);
    await resolveRequest(controls, "local", 1, { emails: [email("restarted-local")] });
    await resolveRequest(controls, "remote", 1, { emails: [email("restarted-remote")] });
    await expect
      .poll(() => readSearch(page))
      .toMatchObject({ status: "complete", remote: ["restarted-remote"] });
    await resolveRequest(controls, "local", 0, { emails: [email("canceled-local")] });
    await resolveRequest(controls, "remote", 0, { error: "Canceled request failed", reject: true });
    await flushResponses(page);
    expect(await readSearch(page)).toMatchObject({
      account: "search-a",
      local: ["restarted-local"],
      remote: ["restarted-remote"],
      status: "complete",
      error: null,
    });
    await expect(page.getByText("Gmail search failed", { exact: true })).toHaveCount(0);
    await controls.dispose();
  } finally {
    await closeApp(app);
  }
});

test("a retry from a canceled search cannot replace a later search with the same text", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    const controls = await installSearchControls(app, page);
    await startSearch(page);
    await expect.poll(() => controls.evaluate((r) => r.remote.length)).toBe(1);
    await resolveRequest(controls, "local", 0, { emails: [] });
    await resolveRequest(controls, "remote", 0, { error: "Initial fixture failure" });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => controls.evaluate((r) => r.remote.length)).toBe(2);
    await page.getByRole("button", { name: "Close search", exact: true }).click();
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([2, 3]);
    await resolveRequest(controls, "local", 1, { emails: [] });
    await resolveRequest(controls, "remote", 2, { emails: [email("latest-search")] });
    await expect
      .poll(() => readSearch(page))
      .toMatchObject({ remote: ["latest-search"], status: "complete" });
    await resolveRequest(controls, "remote", 1, { error: "Old retry failed", reject: true });
    await flushResponses(page);
    expect(await readSearch(page)).toMatchObject({
      remote: ["latest-search"],
      status: "complete",
      error: null,
    });
    await expect(page.getByText("latest-search", { exact: true })).toBeVisible();
    await controls.dispose();
  } finally {
    await closeApp(app);
  }
});

test("obsolete pagination cannot overwrite current results, page token, or loading state", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    const controls = await installSearchControls(app, page);
    const oldPage = Array.from({ length: 50 }, (_, i) => email(`old-page-${i}`));
    const newPage = Array.from({ length: 50 }, (_, i) => email(`new-page-${i}`));
    await startSearch(page);
    await expect.poll(() => controls.evaluate((r) => r.remote.length)).toBe(1);
    await resolveRequest(controls, "local", 0, { emails: [] });
    await resolveRequest(controls, "remote", 0, { emails: oldPage, nextPageToken: "old-page-two" });
    await expect(page.getByText("old-page-0", { exact: true })).toBeVisible();
    await scrollSearchToBottom(page);
    await expect.poll(() => controls.evaluate((r) => r.remote.length)).toBe(2);
    await page.getByRole("button", { name: "Close search", exact: true }).click();
    await startSearch(page);
    await expect
      .poll(() => controls.evaluate((r) => [r.local.length, r.remote.length]))
      .toEqual([2, 3]);
    await resolveRequest(controls, "local", 1, { emails: [] });
    await resolveRequest(controls, "remote", 2, { emails: newPage, nextPageToken: "new-page-two" });
    await expect(page.getByText("new-page-0", { exact: true })).toBeVisible();
    await scrollSearchToBottom(page);
    await expect.poll(() => controls.evaluate((r) => r.remote.length)).toBe(4);
    expect(await controls.evaluate((r) => [r.remote[1].pageToken, r.remote[3].pageToken])).toEqual([
      "old-page-two",
      "new-page-two",
    ]);
    await resolveRequest(controls, "remote", 1, {
      emails: [email("obsolete-page")],
      nextPageToken: "obsolete-next-page",
    });
    await flushResponses(page);
    expect(await readSearch(page)).toMatchObject({
      remote: newPage.map((email) => email.id),
      token: "new-page-two",
      loading: true,
      status: "complete",
    });
    expect(await controls.evaluate((r) => r.remote.length)).toBe(4);
    await resolveRequest(controls, "remote", 3, { emails: [email("current-page-two")] });
    await expect
      .poll(() => readSearch(page))
      .toMatchObject({
        remote: [...newPage.map((email) => email.id), "current-page-two"],
        token: null,
        loading: false,
        status: "complete",
      });
    await expect(page.getByText("obsolete-page", { exact: true })).toHaveCount(0);
    await controls.dispose();
  } finally {
    await closeApp(app);
  }
});

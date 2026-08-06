import { test, expect } from "@playwright/test";
import {
  ScheduledSendService,
  type ScheduledSendDependencies,
} from "../../src/main/services/scheduled-send-service";
import type { ScheduledMessageRow, ScheduledMessageStatus } from "../../src/main/db";
import type { GmailClient } from "../../src/main/services/gmail-client";

function scheduledRow(overrides: Partial<ScheduledMessageRow> = {}): ScheduledMessageRow {
  const now = Date.now();
  return {
    id: "scheduled-1",
    accountId: "account-1",
    type: "send",
    to: ["recipient@example.invalid"],
    subject: "Subject",
    bodyHtml: "<p>Body</p>",
    scheduledAt: now - 1,
    kind: "undo",
    status: "scheduled",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createHarness(
  initialRows: ScheduledMessageRow[],
  options: {
    online?: boolean;
    quitFlushTimeout?: number;
    isNetworkError?: (error: unknown) => boolean;
  } = {},
) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  let online = options.online ?? true;
  let claimCount = 0;
  let setOfflineCount = 0;

  const dependencies: Partial<ScheduledSendDependencies> = {
    getDueScheduledMessages: (limit = 10) =>
      [...rows.values()]
        .filter((row) => row.status === "scheduled" && row.scheduledAt <= Date.now())
        .slice(0, limit),
    getNextScheduledMessageTime: () => {
      const times = [...rows.values()]
        .filter((row) => row.status === "scheduled")
        .map((row) => row.scheduledAt);
      return times.length > 0 ? Math.min(...times) : null;
    },
    getScheduledMessages: (accountId, kind) =>
      [...rows.values()].filter(
        (row) =>
          row.status === "scheduled" &&
          (!accountId || row.accountId === accountId) &&
          (!kind || row.kind === kind),
      ),
    claimScheduledMessage: (id, nextStatus) => {
      claimCount += 1;
      const row = rows.get(id);
      if (!row || row.status !== "scheduled") return null;
      row.status = nextStatus;
      return { ...row };
    },
    updateScheduledMessageStatus: (id, status, errorMessage) => {
      const row = rows.get(id);
      if (!row) return;
      row.status = status;
      row.errorMessage = errorMessage;
    },
    getScheduledMessageStats: () => ({ scheduled: 0, total: 0 }),
    network: {
      get isOnline() {
        return online;
      },
      setOffline() {
        online = false;
        setOfflineCount += 1;
      },
    },
    isNetworkError:
      options.isNetworkError ??
      ((error) => (error as NodeJS.ErrnoException | undefined)?.code === "ECONNRESET"),
    now: Date.now,
    quitFlushTimeout: options.quitFlushTimeout ?? 20,
  };

  return {
    service: new ScheduledSendService(dependencies),
    status(id: string): ScheduledMessageStatus | undefined {
      return rows.get(id)?.status;
    },
    get claimCount() {
      return claimCount;
    },
    get setOfflineCount() {
      return setOfflineCount;
    },
  };
}

function gmailClient(sendMessage: GmailClient["sendMessage"]): GmailClient {
  return { sendMessage } as unknown as GmailClient;
}

test.describe("scheduled send service — retry and shutdown", () => {
  test("leaves a due message scheduled while the app is offline", async () => {
    const harness = createHarness([scheduledRow()], { online: false });
    harness.service.setClientResolver(() =>
      gmailClient(async () => ({ id: "gmail-1", threadId: "thread-1" })),
    );

    await harness.service.processDueMessages();

    expect(harness.status("scheduled-1")).toBe("scheduled");
    expect(harness.claimCount).toBe(0);
  });

  test("retries a transient network failure instead of failing the message", async () => {
    const harness = createHarness([scheduledRow()]);
    let failedEvents = 0;
    harness.service.on("failed", () => {
      failedEvents += 1;
    });
    harness.service.setClientResolver(() =>
      gmailClient(async () => {
        const error = new Error("socket reset") as NodeJS.ErrnoException;
        error.code = "ECONNRESET";
        throw error;
      }),
    );

    await harness.service.processDueMessages();

    expect(harness.status("scheduled-1")).toBe("scheduled");
    expect(harness.setOfflineCount).toBe(1);
    expect(failedEvents).toBe(0);
  });

  test("keeps a message pending while its account client reconnects", async () => {
    const harness = createHarness([scheduledRow()]);
    harness.service.setClientResolver(() => null);

    await harness.service.processDueMessages();

    expect(harness.status("scheduled-1")).toBe("scheduled");
    expect(harness.claimCount).toBe(0);
  });

  test("quit aborts and settles an already-active send before returning", async () => {
    const harness = createHarness([scheduledRow()], { quitFlushTimeout: 20 });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let abortSettled = false;

    harness.service.setClientResolver(() =>
      gmailClient(
        (_options, requestOptions) =>
          new Promise((_, reject) => {
            requestStarted();
            requestOptions.signal?.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  abortSettled = true;
                  reject(new DOMException("Aborted", "AbortError"));
                }, 5);
              },
              { once: true },
            );
          }),
      ),
    );

    const processing = harness.service.processDueMessages();
    await started;
    expect(harness.status("scheduled-1")).toBe("sending");

    await harness.service.flushPendingNow();
    await processing;

    expect(abortSettled).toBe(true);
    expect(harness.status("scheduled-1")).toBe("scheduled");
  });
});

import { test, expect, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import { FAKE_INBOX_EMAILS, EXPECTED_ANALYSIS } from "./fixtures/fake-emails";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration tests for Exo using fake inbox data
// These tests verify the UI and workflow without connecting to real Gmail

let electronApp: ElectronApplication;
let page: Page;

test.describe("Exo Integration Tests", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    // Launch the Electron app in test mode
    electronApp = await electron.launch({
      args: [path.join(__dirname, "../out/main/index.js")],
      env: {
        ...process.env,
        NODE_ENV: "test",
        EXO_TEST_MODE: "true",
      },
    });

    // Get the first window
    page = await electronApp.firstWindow();

    // Capture console logs
    page.on("console", (msg) => {
      console.log(`[Renderer ${msg.type()}]: ${msg.text()}`);
    });

    // Capture errors
    page.on("pageerror", (err) => {
      console.error(`[Renderer error]: ${err.message}`);
    });

    await page.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    if (electronApp) {
      // Race close() against a 15s timeout; SIGKILL if close() doesn't finish
      const pid = electronApp.process().pid;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          electronApp.close(),
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("close timed out")), 15000);
          }),
        ]);
      } catch {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  });

  test("app launches and shows main window", async () => {
    // Verify the app title or header is visible
    const title = await page.locator("text=Exo").first();
    await expect(title).toBeVisible({ timeout: 10000 });
  });

  test("shows setup wizard when not authenticated", async () => {
    // The setup wizard should appear if there are no credentials
    const setupTitle = page.locator("text=Connect to Gmail").first();

    // Either setup wizard or main inbox UI should be visible
    const mainUI = page.locator("text=Inbox").first();

    const setupVisible = await setupTitle.isVisible().catch(() => false);
    const mainVisible = await mainUI.isVisible().catch(() => false);

    expect(setupVisible || mainVisible).toBe(true);
  });
});

// Unit tests for the mock system
test.describe("Mock System Tests", () => {
  test("fake emails fixture has expected data", async () => {
    expect(FAKE_INBOX_EMAILS).toHaveLength(6);

    // Verify email structure
    for (const email of FAKE_INBOX_EMAILS) {
      expect(email.id).toBeTruthy();
      expect(email.threadId).toBeTruthy();
      expect(email.subject).toBeTruthy();
      expect(email.from).toBeTruthy();
      expect(email.to).toBeTruthy();
      expect(email.body).toBeTruthy();
    }
  });

  test("expected analysis covers all fake emails", async () => {
    for (const email of FAKE_INBOX_EMAILS) {
      const analysis = EXPECTED_ANALYSIS[email.id as keyof typeof EXPECTED_ANALYSIS];
      expect(analysis).toBeDefined();
      expect(typeof analysis.needsReply).toBe("boolean");
    }
  });

  test("emails requiring reply are correctly identified", async () => {
    // These emails should need a reply
    const shouldReply = ["msg-001", "msg-002", "msg-005"];
    for (const id of shouldReply) {
      const analysis = EXPECTED_ANALYSIS[id as keyof typeof EXPECTED_ANALYSIS];
      expect(analysis.needsReply).toBe(true);
    }

    // These emails should NOT need a reply
    const shouldNotReply = ["msg-003", "msg-004", "msg-006"];
    for (const id of shouldNotReply) {
      const analysis = EXPECTED_ANALYSIS[id as keyof typeof EXPECTED_ANALYSIS];
      expect(analysis.needsReply).toBe(false);
    }
  });
});

// Service layer tests using mocks
test.describe("Mock Gmail Client Tests", () => {
  test("mock client can search emails", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    const { results } = await client.searchEmails("in:inbox is:unread", 10);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(results.length).toBeGreaterThan(0);

    await client.disconnect();
  });

  test("mock client can read specific email", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    const email = await client.readEmail("msg-001");
    expect(email).not.toBeNull();
    expect(email?.subject).toBe("Project Status Update Request");

    await client.disconnect();
  });

  test("mock client can create drafts", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    const result = await client.createDraft({
      to: "test@example.com",
      subject: "Test Draft",
      body: "This is a test draft",
    });

    expect(result.id).toMatch(/^draft-\d+$/);
    expect(client.getDrafts().size).toBe(1);

    client.clearDrafts();
    await client.disconnect();
  });
});

// Tests for compose/send functionality using mocks
// IMPORTANT: These tests NEVER send real emails
test.describe("Mock Compose/Send Tests", () => {
  test("mock sendMessage returns fake IDs (no real send)", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // This does NOT send a real email - it only creates mock data
    const result = await client.sendMessage({
      to: ["test@example.com"],
      subject: "Test Subject",
      bodyText: "Test body content",
    });

    expect(result.id).toMatch(/^mock-sent-\d+$/);
    expect(result.threadId).toMatch(/^mock-thread-\d+$/);

    // Verify the message is stored in mock storage
    const sentMessages = client.getSentMessages();
    expect(sentMessages.size).toBe(1);
    expect(sentMessages.get(result.id)?.to).toEqual(["test@example.com"]);

    client.clearAll();
    await client.disconnect();
  });

  test("mock createFullDraft stores draft locally (no Gmail API call)", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    const result = await client.createFullDraft({
      to: ["recipient@example.com"],
      cc: ["cc@example.com"],
      subject: "Full Draft Test",
      bodyHtml: "<p>HTML body</p>",
      bodyText: "Plain text body",
    });

    expect(result.id).toMatch(/^mock-draft-\d+$/);
    expect(result.messageId).toMatch(/^mock-draft-msg-\d+$/);

    // Verify draft is stored
    const drafts = client.getDrafts();
    expect(drafts.size).toBe(1);

    const draft = drafts.get(result.id);
    expect(draft?.subject).toBe("Full Draft Test");
    expect(draft?.cc).toEqual(["cc@example.com"]);

    client.clearAll();
    await client.disconnect();
  });

  test("mock sendDraft removes draft and creates sent message (no real send)", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // First create a draft
    const draftResult = await client.createFullDraft({
      to: ["recipient@example.com"],
      subject: "Draft to Send",
      bodyText: "Content",
    });

    expect(client.getDrafts().size).toBe(1);

    // Send the draft (mock - no real email sent)
    const sendResult = await client.sendDraft(draftResult.id);

    expect(sendResult.id).toMatch(/^mock-sent-\d+$/);

    // Draft should be removed
    expect(client.getDrafts().size).toBe(0);

    // Sent message should be stored
    expect(client.getSentMessages().size).toBe(1);

    client.clearAll();
    await client.disconnect();
  });

  test("mock updateDraft modifies existing draft", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // Create a draft
    const draftResult = await client.createFullDraft({
      to: ["original@example.com"],
      subject: "Original Subject",
      bodyText: "Original content",
    });

    // Update the draft
    await client.updateDraft(draftResult.id, {
      to: ["updated@example.com"],
      subject: "Updated Subject",
      bodyText: "Updated content",
    });

    const draft = client.getDrafts().get(draftResult.id);
    expect(draft?.to).toEqual(["updated@example.com"]);
    expect(draft?.subject).toBe("Updated Subject");

    client.clearAll();
    await client.disconnect();
  });

  test("mock deleteDraft removes draft", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // Create a draft
    const draftResult = await client.createFullDraft({
      to: ["test@example.com"],
      subject: "Draft to Delete",
      bodyText: "Content",
    });

    expect(client.getDrafts().size).toBe(1);

    // Delete the draft
    await client.deleteDraft(draftResult.id);

    expect(client.getDrafts().size).toBe(0);

    client.clearAll();
    await client.disconnect();
  });

  test("mock listDrafts returns all drafts", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // Create multiple drafts
    await client.createFullDraft({ to: ["a@example.com"], subject: "Draft 1", bodyText: "1" });
    await client.createFullDraft({ to: ["b@example.com"], subject: "Draft 2", bodyText: "2" });
    await client.createFullDraft({ to: ["c@example.com"], subject: "Draft 3", bodyText: "3" });

    const drafts = await client.listDrafts();
    expect(drafts.length).toBe(3);

    client.clearAll();
    await client.disconnect();
  });

  test("mock email actions are no-ops (archive, trash, star, read)", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    // These should all complete without error but do nothing real
    await expect(client.archiveMessage("msg-001")).resolves.toBeUndefined();
    await expect(client.trashMessage("msg-001")).resolves.toBeUndefined();
    await expect(client.setStarred("msg-001", true)).resolves.toBeUndefined();
    await expect(client.setRead("msg-001", true)).resolves.toBeUndefined();

    await client.disconnect();
  });

  test("mock getMessageHeaders returns fake headers", async () => {
    const { MockGmailClient } = await import("./mocks/mock-gmail-client");
    const client = new MockGmailClient();
    await client.connect();

    const headers = await client.getMessageHeaders("msg-001");
    expect(headers).not.toBeNull();
    expect(headers?.messageId).toContain("msg-001");
    expect(headers?.subject).toBe("Project Status Update Request");

    // Non-existent message returns null
    const noHeaders = await client.getMessageHeaders("non-existent");
    expect(noHeaders).toBeNull();

    await client.disconnect();
  });
});

test.describe("Mock Analyzer Tests", () => {
  test("analyzer returns expected results for known emails", async () => {
    const { MockEmailAnalyzer } = await import("./mocks/mock-analysis");
    const { FAKE_INBOX_EMAILS } = await import("./fixtures/fake-emails");

    const analyzer = new MockEmailAnalyzer();

    // Test Priority (needs-reply) email
    const email1 = FAKE_INBOX_EMAILS.find((e) => e.id === "msg-001")!;
    const result1 = await analyzer.analyze(email1);
    expect(result1.needs_reply).toBe(true);

    // Test newsletter (no reply needed)
    const email4 = FAKE_INBOX_EMAILS.find((e) => e.id === "msg-004")!;
    const result4 = await analyzer.analyze(email4);
    expect(result4.needs_reply).toBe(false);
  });

  test("draft generator creates appropriate mock drafts", async () => {
    const { MockDraftGenerator } = await import("./mocks/mock-analysis");
    const { FAKE_INBOX_EMAILS } = await import("./fixtures/fake-emails");

    const generator = new MockDraftGenerator();
    const email = FAKE_INBOX_EMAILS[0];

    const draft = await generator.generateDraft(email, {
      needs_reply: true,
      reason: "Test reason",
    });

    expect(draft).toContain("Hi Sarah Johnson");
    expect(draft).toContain(email.subject);
    expect(draft).toContain("mock-generated draft");
  });
});

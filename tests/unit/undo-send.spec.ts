/**
 * Unit tests for Undo Send feature — composeContext completeness
 *
 * Validates that every location where a composeContext object is built includes
 * the `subject` field, so the draft can be fully restored when the user clicks
 * "Undo" after sending.
 *
 * Run with: npx playwright test tests/unit/undo-send.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../../src");

// ---------------------------------------------------------------------------
// Helper: extract all composeContext object literals from source code
// Returns an array of { file, startLine, block } objects.
// ---------------------------------------------------------------------------
function extractComposeContextBlocks(
  filePath: string,
): Array<{ file: string; startLine: number; block: string }> {
  const code = readFileSync(filePath, "utf-8");
  const lines = code.split("\n");
  const results: Array<{ file: string; startLine: number; block: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    // Look for `composeContext: {`
    if (/composeContext\s*:\s*\{/.test(lines[i])) {
      let braceCount = 0;
      let started = false;
      let block = "";
      for (let j = i; j < lines.length; j++) {
        const line = lines[j];
        for (const ch of line) {
          if (ch === "{") {
            braceCount++;
            started = true;
          }
          if (ch === "}") braceCount--;
        }
        block += line + "\n";
        if (started && braceCount === 0) break;
      }
      results.push({ file: filePath, startLine: i + 1, block });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test suite 1: composeContext completeness across all send locations
// ---------------------------------------------------------------------------
test.describe("Undo Send - composeContext field completeness", () => {
  const emailDetailPath = path.join(srcDir, "renderer/components/EmailDetail.tsx");
  const useComposeFormPath = path.join(srcDir, "renderer/hooks/useComposeForm.ts");

  test("InlineReply composeContext (EmailDetail.tsx) includes subject", () => {
    const blocks = extractComposeContextBlocks(emailDetailPath);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const inlineReplyBlock = blocks[0];
    expect(inlineReplyBlock.block).toContain("subject");
  });

  test("useComposeForm composeContext includes subject", () => {
    const blocks = extractComposeContextBlocks(useComposeFormPath);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const composeBlock = blocks[0];
    expect(composeBlock.block).toContain("subject");
  });

  test("all composeContext blocks across codebase include subject field", () => {
    const allBlocks = [
      ...extractComposeContextBlocks(emailDetailPath),
      ...extractComposeContextBlocks(useComposeFormPath),
    ];

    // There should be exactly 2 locations: InlineReply (EmailDetail) + shared hook (useComposeForm)
    expect(allBlocks.length).toBe(2);

    for (const { file, startLine, block } of allBlocks) {
      const shortFile = path.relative(srcDir, file);
      expect(
        block,
        `composeContext at ${shortFile}:${startLine} is missing 'subject' field`,
      ).toContain("subject");
    }
  });

  test("InlineReply composeContext uses replyInfo.subject (not a different source)", () => {
    const blocks = extractComposeContextBlocks(emailDetailPath);
    const inlineReplyBlock = blocks[0];
    expect(inlineReplyBlock.block).toMatch(/subject\s*:\s*replyInfo\.subject/);
  });

  test("all composeContext blocks include all required fields", () => {
    const requiredFields = ["mode", "bodyHtml", "bodyText", "to"];

    const allBlocks = [
      ...extractComposeContextBlocks(emailDetailPath),
      ...extractComposeContextBlocks(useComposeFormPath),
    ];

    for (const { file, startLine, block } of allBlocks) {
      const shortFile = path.relative(srcDir, file);
      for (const field of requiredFields) {
        expect(
          block,
          `composeContext at ${shortFile}:${startLine} is missing required '${field}' field`,
        ).toContain(field);
      }
      // subject should also be present in all blocks
      expect(
        block,
        `composeContext at ${shortFile}:${startLine} is missing 'subject' field`,
      ).toContain("subject");
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: UndoSendItem type and store integration
// ---------------------------------------------------------------------------
test.describe("Undo Send - UndoSendItem type and store", () => {
  test("UndoSendItem type has composeContext with subject field", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");

    // Verify the composeContext type definition includes subject
    expect(storeCode).toContain("composeContext?: {");
    expect(storeCode).toContain("subject?: string");
  });

  test("RestoredDraft type includes subject field", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");

    // Verify the RestoredDraft type includes subject
    expect(storeCode).toContain("export type RestoredDraft = {");
    expect(storeCode).toContain("subject?: string");
  });

  test("store has undo send state and actions", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");

    expect(storeCode).toContain("undoSendDelaySeconds: number");
    expect(storeCode).toContain("undoSendQueue: UndoSendItem[]");
    expect(storeCode).toContain("setUndoSendDelay");
    expect(storeCode).toContain("addUndoSend");
    expect(storeCode).toContain("removeUndoSend");
  });

  test("default undo send delay is 5 seconds", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");
    expect(storeCode).toContain("undoSendDelaySeconds: 5");
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: UndoSendToast uses subject from composeContext when restoring
// ---------------------------------------------------------------------------
test.describe("Undo Send - Toast restoration flow", () => {
  test("UndoSendToast handleUndo passes subject to openCompose", () => {
    const toastCode = readFileSync(
      path.join(srcDir, "renderer/components/UndoSendToast.tsx"),
      "utf-8",
    );

    // The handleUndo callback should pass ctx.subject to store.openCompose
    expect(toastCode).toContain("ctx.subject");
    expect(toastCode).toContain("subject: ctx.subject");
  });

  test("UndoSendToast handleUndo restores all draft fields", () => {
    const toastCode = readFileSync(
      path.join(srcDir, "renderer/components/UndoSendToast.tsx"),
      "utf-8",
    );

    // All restored fields should be passed to openCompose
    expect(toastCode).toContain("bodyHtml: ctx.bodyHtml");
    expect(toastCode).toContain("bodyText: ctx.bodyText");
    expect(toastCode).toContain("to: ctx.to");
    expect(toastCode).toContain("cc: ctx.cc");
    expect(toastCode).toContain("subject: ctx.subject");
  });

  test("UndoSendToast removes optimistic email on undo", () => {
    const toastCode = readFileSync(
      path.join(srcDir, "renderer/components/UndoSendToast.tsx"),
      "utf-8",
    );

    expect(toastCode).toContain("optimisticEmailId");
    expect(toastCode).toContain("emails: s.emails.filter((e) => e.id !== optimisticId)");
  });

  test("UndoSendToast supports keyboard shortcut for undo", () => {
    const toastCode = readFileSync(
      path.join(srcDir, "renderer/components/UndoSendToast.tsx"),
      "utf-8",
    );

    // Cmd+Z / Ctrl+Z support
    expect(toastCode).toContain("e.metaKey || e.ctrlKey");
    expect(toastCode).toContain('e.key === "z"');
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: InlineReply uses restoredDraft.subject correctly
// ---------------------------------------------------------------------------
test.describe("Undo Send - InlineReply draft restoration", () => {
  test("InlineReply accepts restoredDraft prop", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");

    // InlineReply component accepts restoredDraft as a prop
    expect(code).toContain("restoredDraft?: RestoredDraft");
  });

  test("InlineReply initializes 'to' from restoredDraft when present", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");

    // Verify it uses restoredDraft?.to as initial value for toAddresses
    expect(code).toContain("restoredDraft?.to !== undefined ? restoredDraft.to :");
  });

  test("InlineReply initializes bodyHtml from restoredDraft when present", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");

    expect(code).toContain('restoredDraft?.bodyHtml || ""');
  });

  test("EmailDetail captures restoredDraft before closing compose state", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");

    // This is critical: the restored draft must be captured before closeCompose
    expect(code).toContain("composeState.restoredDraft ?? null");
    expect(code).toContain("setRestoredDraft(restored)");
  });
});

// ---------------------------------------------------------------------------
// Test suite 5: Settings UI for undo send delay
// ---------------------------------------------------------------------------
test.describe("Undo Send - Settings UI", () => {
  test("SettingsPanel exposes undo send delay options", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/SettingsPanel.tsx"), "utf-8");

    expect(code).toContain("undoSendDelaySeconds");
    expect(code).toContain("setUndoSendDelay");
  });

  test("SettingsPanel has preset delay values (0, 5, 10, 15, 30)", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/SettingsPanel.tsx"), "utf-8");

    // Check for all preset button values
    expect(code).toContain('"Off"');
    expect(code).toContain('"5s"');
    expect(code).toContain('"10s"');
    expect(code).toContain('"15s"');
    expect(code).toContain('"30s"');
  });

  test("SettingsPanel persists delay via settings API", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/SettingsPanel.tsx"), "utf-8");

    expect(code).toContain("window.api.settings.set");
    expect(code).toContain("undoSendDelay");
  });
});

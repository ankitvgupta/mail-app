import { useEditor, EditorContent } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";

// Extract Editor type from useEditor return type
type Editor = NonNullable<ReturnType<typeof useEditor>>;
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useAppStore } from "../store";
import { ContactMention } from "./MentionSuggestion";
import type { Snippet } from "../../shared/types";

interface ComposeEditorProps {
  initialContent?: string;
  quotedContent?: string; // Raw HTML of quoted email - rendered separately, not editable
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Called when a contact is selected via @mention or +mention in the body */
  onAddToCc?: (email: string) => void;
  /** Recipient email for snippet variable resolution */
  recipientEmail?: string;
}

// Toolbar button component
function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      tabIndex={-1}
      className={`p-1.5 rounded text-sm ${
        active
          ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * Read a File as a data URI string.
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Snippet picker dropdown
function SnippetPicker({
  snippets,
  onSelect,
  onClose,
}: {
  snippets: Snippet[];
  onSelect: (snippet: Snippet) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-snippet-picker]")) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const filtered = search
    ? snippets.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.shortcut && s.shortcut.toLowerCase().includes(search.toLowerCase())),
      )
    : snippets;

  return (
    <div
      data-snippet-picker
      className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-64 flex flex-col"
    >
      <div className="p-2 border-b border-gray-200 dark:border-gray-700">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search snippets..."
          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && filtered.length > 0) {
              onSelect(filtered[0]);
            }
          }}
        />
      </div>
      <div className="overflow-y-auto flex-1">
        {filtered.length === 0 ? (
          <div className="p-3 text-sm text-gray-500 dark:text-gray-400 text-center">
            {snippets.length === 0 ? "No snippets. Create them in Settings." : "No matches."}
          </div>
        ) : (
          filtered.map((snippet) => (
            <button
              key={snippet.id}
              onClick={() => onSelect(snippet)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 dark:text-gray-100">{snippet.name}</span>
                {snippet.shortcut && (
                  <span className="px-1 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded font-mono">
                    ;{snippet.shortcut}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                {snippet.body.replace(/<[^>]*>/g, "").substring(0, 80)}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Resolve snippet variables:
 * - {first_name} → recipient's first name
 * - {my_name} → sender's display name
 * - {custom_var} → prompt user
 */
function resolveSnippetVariables(
  body: string,
  recipientEmail?: string,
  senderName?: string,
): string {
  let resolved = body;

  // System variables that are auto-resolved (not prompted)
  const SYSTEM_VARS = new Set(["my_name", "first_name"]);

  // Resolve {my_name} — use replacer function to avoid $-pattern interpretation
  if (senderName) {
    resolved = resolved.replace(/\{my_name\}/gi, () => senderName);
  }

  // Resolve {first_name} from recipient email (best effort: take part before @, capitalize)
  if (recipientEmail) {
    const localPart = recipientEmail.split("@")[0] || "";
    const firstName = localPart.split(/[._-]/)[0];
    const capitalized = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    resolved = resolved.replace(/\{first_name\}/gi, () => capitalized);
  }

  // Find remaining custom placeholders and prompt for them
  const customVarRegex = /\{(\w+)\}/g;
  let match;
  const prompted = new Map<string, string>();
  while ((match = customVarRegex.exec(resolved)) !== null) {
    const varName = match[1];
    // Skip system variables that weren't resolved (missing context)
    if (SYSTEM_VARS.has(varName.toLowerCase())) continue;
    if (!prompted.has(varName)) {
      const value = window.prompt(`Fill in {${varName}}:`, "") ?? "";
      prompted.set(varName, value);
    }
  }

  for (const [varName, value] of prompted) {
    resolved = resolved.replace(new RegExp(`\\{${varName}\\}`, "gi"), () => value);
  }

  return resolved;
}

// Toolbar component
function Toolbar({
  editor,
  snippets,
  onInsertSnippet,
}: {
  editor: Editor | null;
  snippets: Snippet[];
  onInsertSnippet: (snippet: Snippet) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSnippetPicker, setShowSnippetPicker] = useState(false);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("Enter URL:", previousUrl || "https://");

    if (url === null) return;

    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const insertImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!editor) return;
      const files = e.target.files;
      if (!files || files.length === 0) return;

      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        // Limit to 10MB per image
        if (file.size > 10 * 1024 * 1024) {
          console.warn(`Skipping image ${file.name}: exceeds 10MB limit`);
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        editor.chain().focus().setImage({ src: dataUrl, alt: file.name }).run();
      }

      // Reset input so the same file can be selected again
      e.target.value = "";
    },
    [editor],
  );

  if (!editor) return null;

  return (
    <div className="flex items-center gap-0.5 p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold (Cmd+B)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z"
          />
        </svg>
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic (Cmd+I)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 4h4m-2 0v16m-4 0h8"
            transform="skewX(-10)"
          />
        </svg>
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6v6m0 6v-6m-6 0h12"
          />
        </svg>
      </ToolbarButton>

      <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet list"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
          <circle cx="2" cy="6" r="1" fill="currentColor" />
          <circle cx="2" cy="12" r="1" fill="currentColor" />
          <circle cx="2" cy="18" r="1" fill="currentColor" />
        </svg>
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Numbered list"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 6h13M7 12h13M7 18h13"
          />
          <text x="1" y="8" fontSize="6" fill="currentColor">
            1
          </text>
          <text x="1" y="14" fontSize="6" fill="currentColor">
            2
          </text>
          <text x="1" y="20" fontSize="6" fill="currentColor">
            3
          </text>
        </svg>
      </ToolbarButton>

      <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

      {/* Block quote */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        title="Quote"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </ToolbarButton>

      {/* Link */}
      <ToolbarButton onClick={setLink} active={editor.isActive("link")} title="Insert link">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      </ToolbarButton>

      <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

      {/* Insert image */}
      <ToolbarButton onClick={insertImage} title="Insert image">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </ToolbarButton>
      {/* Hidden file input for image picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Insert snippet */}
      <div className="relative">
        <ToolbarButton
          onClick={() => setShowSnippetPicker(!showSnippetPicker)}
          active={showSnippetPicker}
          title="Insert snippet (;)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
        </ToolbarButton>
        {showSnippetPicker && (
          <SnippetPicker
            snippets={snippets}
            onSelect={(snippet) => {
              onInsertSnippet(snippet);
              setShowSnippetPicker(false);
            }}
            onClose={() => setShowSnippetPicker(false)}
          />
        )}
      </div>

      <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

      {/* Text alignment */}
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        active={editor.isActive({ textAlign: "left" })}
        title="Align left"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h10M4 18h14"
          />
        </svg>
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        active={editor.isActive({ textAlign: "center" })}
        title="Align center"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M7 12h10M5 18h14"
          />
        </svg>
      </ToolbarButton>
    </div>
  );
}

export function ComposeEditor({
  initialContent = "",
  quotedContent,
  onChange,
  placeholder = "Write your message...",
  className = "",
  autoFocus = false,
  onAddToCc,
  recipientEmail,
}: ComposeEditorProps) {
  const isDark = useAppStore((s) => s.resolvedTheme) === "dark";
  const snippets = useAppStore((s) => s.snippets);
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const accounts = useAppStore((s) => s.accounts);
  const accountSnippets = snippets.filter((s) => s.accountId === currentAccountId);
  const currentAccountRecord = accounts.find((a) => a.id === currentAccountId);
  const senderName =
    currentAccountRecord?.displayName || currentAccountRecord?.email?.split("@")[0];

  // Ref keeps the latest onAddToCc without recreating extensions
  const onAddToCcRef = useRef<((email: string) => void) | null>(onAddToCc ?? null);
  useEffect(() => {
    onAddToCcRef.current = onAddToCc ?? null;
  }, [onAddToCc]);

  // Stable ref object for the extension (created once)
  const stableRef = useMemo(() => onAddToCcRef, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-blue-600 underline",
        },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          style: "max-width: 100%; height: auto;",
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      TextAlign.configure({
        types: ["paragraph"],
      }),
      ContactMention.configure({
        onAddToCcRef: stableRef,
      }),
    ],
    content: initialContent,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[100px] p-3",
      },
      // Handle paste and drop of images
      handlePaste: (view: EditorView, event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return false;

        const imageFiles: File[] = [];
        for (const item of Array.from(items)) {
          if (!item.type.startsWith("image/")) continue;
          const file = item.getAsFile();
          if (!file || file.size > 10 * 1024 * 1024) continue;
          imageFiles.push(file);
        }
        if (imageFiles.length === 0) return false;

        event.preventDefault();
        // Capture position before async work to avoid stale state
        const insertPos = view.state.selection.from;
        Promise.all(
          imageFiles.map((file) =>
            readFileAsDataUrl(file).then((dataUrl) => ({ dataUrl, name: file.name })),
          ),
        ).then((images) => {
          let tr = view.state.tr;
          let pos = insertPos;
          for (const img of images) {
            const node = view.state.schema.nodes.image.create({ src: img.dataUrl, alt: img.name });
            tr = tr.insert(pos, node);
            pos += node.nodeSize;
          }
          view.dispatch(tr);
        });
        return true;
      },
      handleDrop: (view: EditorView, event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;

        const imageFiles = Array.from(files).filter(
          (f: File) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024,
        );
        if (imageFiles.length === 0) return false;

        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });

        // Resolve all files first, then insert in a single transaction to avoid stale positions
        Promise.all(
          imageFiles.map((file) =>
            readFileAsDataUrl(file).then((dataUrl) => ({ dataUrl, name: file.name })),
          ),
        ).then((images) => {
          let tr = view.state.tr;
          let insertPos = pos?.pos ?? view.state.selection.from;
          for (const img of images) {
            const node = view.state.schema.nodes.image.create({ src: img.dataUrl, alt: img.name });
            tr = tr.insert(insertPos, node);
            insertPos += node.nodeSize;
          }
          view.dispatch(tr);
        });
        return true;
      },
    },
    onUpdate: ({ editor }: { editor: Editor }) => {
      const html = editor.getHTML();
      const text = editor.getText();
      onChange(html, text);
    },
  });

  // Update content when initialContent changes (for editing drafts)
  useEffect(() => {
    if (editor && initialContent !== editor.getHTML()) {
      editor.commands.setContent(initialContent);
    }
  }, [initialContent, editor]);

  return (
    <div
      className={`border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-white dark:bg-gray-800 ${className}`}
    >
      <Toolbar
        editor={editor}
        snippets={accountSnippets}
        onInsertSnippet={(snippet) => {
          if (!editor) return;
          const resolved = resolveSnippetVariables(snippet.body, recipientEmail, senderName);
          const sanitized = DOMPurify.sanitize(resolved);
          editor.chain().focus().insertContent(sanitized).run();
        }}
      />
      <div className="dark:text-gray-100">
        <EditorContent editor={editor} />
      </div>
      {/* Quoted content rendered as non-editable HTML */}
      {quotedContent && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <div
            className="p-3 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50"
            style={{ maxHeight: "300px", overflowY: "auto" }}
          >
            {/* Use an iframe to safely render the original email HTML with all its styles */}
            <iframe
              srcDoc={`
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="utf-8">
                  <style>
                    body {
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      font-size: 14px;
                      line-height: 1.5;
                      color: ${isDark ? "#e5e7eb" : "#333"};
                      background: ${isDark ? "#1f2937" : "transparent"};
                      margin: 0;
                      padding: 0;
                    }
                    blockquote {
                      border-left: 2px solid ${isDark ? "#4b5563" : "#ccc"};
                      margin: 8px 0;
                      padding-left: 12px;
                      color: ${isDark ? "#9ca3af" : "#555"};
                    }
                    img { max-width: 100%; height: auto; }
                    a { color: ${isDark ? "#60a5fa" : "#1a73e8"}; }
                  </style>
                </head>
                <body>${quotedContent}</body>
                </html>
              `}
              title="Quoted content"
              className="w-full border-0"
              style={{ minHeight: "150px", height: "auto" }}
              sandbox="allow-same-origin"
              onLoad={(e) => {
                // Auto-resize iframe to fit content
                const iframe = e.target as HTMLIFrameElement;
                if (iframe.contentDocument) {
                  const height = iframe.contentDocument.body.scrollHeight;
                  iframe.style.height = `${Math.min(height + 20, 400)}px`;
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default ComposeEditor;

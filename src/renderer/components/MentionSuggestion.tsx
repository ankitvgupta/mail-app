import { forwardRef, useEffect, useImperativeHandle, useState, useCallback } from "react";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import type { ContactSuggestion, IpcResponse } from "../../shared/types";
import { extractFirstName } from "../utils/address-parsing";

// --- MentionList component (rendered inside the tippy popup) ---

interface MentionListProps {
  items: ContactSuggestion[];
  command: (item: ContactSuggestion) => void;
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const MentionList = forwardRef<MentionListRef, MentionListProps>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) command(item);
    },
    [items, command],
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i >= items.length - 1 ? 0 : i + 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-xl dark:shadow-black/50 max-h-60 overflow-y-auto z-50"
      data-testid="mention-dropdown"
    >
      {items.map((item, index) => (
        <div
          key={item.email}
          className={`px-4 py-2.5 cursor-pointer text-sm flex items-center justify-between gap-4 ${
            index === selectedIndex
              ? "bg-blue-50 dark:bg-gray-700"
              : "hover:bg-gray-100 dark:hover:bg-gray-700/50"
          }`}
          onClick={() => selectItem(index)}
          onMouseEnter={() => setSelectedIndex(index)}
          data-testid="mention-suggestion"
        >
          <span className="text-gray-900 dark:text-gray-100 truncate">
            {item.name || item.email}
          </span>
          {item.name && (
            <span className="text-gray-500 dark:text-gray-500 text-sm truncate flex-shrink-0">
              {item.email}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";

// --- Suggestion render factory (shared between @ and + triggers) ---

function createSuggestionRender() {
  return () => {
    let component: ReactRenderer<MentionListRef, MentionListProps>;
    let popup: TippyInstance[];

    return {
      onStart: (props: SuggestionProps<ContactSuggestion>) => {
        component = new ReactRenderer(MentionList, {
          props: { items: props.items, command: props.command },
          editor: props.editor,
        });

        if (!props.clientRect) return;

        popup = tippy("body", {
          getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "bottom-start",
        });
      },

      onUpdate: (props: SuggestionProps<ContactSuggestion>) => {
        component?.updateProps({
          items: props.items,
          command: props.command,
        });

        if (!props.clientRect || !popup?.[0]) return;

        popup[0].setProps({
          getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
        });
      },

      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === "Escape") {
          // Let the plugin handle Escape natively so it resets internal state
          return false;
        }
        return component?.ref?.onKeyDown(props) ?? false;
      },

      onExit: () => {
        popup?.[0]?.destroy();
        component?.destroy();
      },
    };
  };
}

// --- Suggestion config factory ---

function createSuggestionConfig(
  char: string,
  pluginKey: PluginKey,
  onAddToCcRef: React.RefObject<((email: string, name?: string) => void) | null>,
): Omit<SuggestionOptions<ContactSuggestion>, "editor"> {
  return {
    char,
    pluginKey,
    allowedPrefixes: [" "],

    items: async ({ query }): Promise<ContactSuggestion[]> => {
      if (!query.trim()) return [];
      try {
        const response = (await window.api.contacts.suggest(query, 8)) as IpcResponse<
          ContactSuggestion[]
        >;
        if (response.success) return response.data;
      } catch {
        // Autocomplete is non-critical
      }
      return [];
    },

    command: ({ editor, range, props: item }) => {
      const firstName = extractFirstName((item.name || item.email).trim()) || item.email;
      // Replace trigger + query with the person's first name
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent(firstName + " ")
        .run();
      // Side effect: add to CC
      onAddToCcRef.current?.(item.email, item.name);
    },

    render: createSuggestionRender(),
  };
}

// --- Custom Tiptap Extension ---

const atPluginKey = new PluginKey("contactMentionAt");
const plusPluginKey = new PluginKey("contactMentionPlus");

interface ContactMentionOptions {
  onAddToCcRef: React.RefObject<((email: string, name?: string) => void) | null>;
}

/**
 * Lightweight extension that triggers contact autocomplete on @ and +.
 * Inserts plain text (first name) and adds the selected contact to CC.
 */
export const ContactMention = Extension.create<ContactMentionOptions>({
  name: "contactMention",

  addOptions() {
    return {
      onAddToCcRef: { current: null },
    };
  },

  addProseMirrorPlugins() {
    const ref = this.options.onAddToCcRef;
    return [
      Suggestion({
        editor: this.editor,
        ...createSuggestionConfig("@", atPluginKey, ref),
      }),
      Suggestion({
        editor: this.editor,
        ...createSuggestionConfig("+", plusPluginKey, ref),
      }),
    ];
  },
});

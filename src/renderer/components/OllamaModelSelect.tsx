import { useEffect, useState } from "react";
import { COMMON_OLLAMA_MODELS, DEFAULT_OLLAMA_MODEL } from "../../shared/types";

/** Sentinel <option> value that switches the field into free-text entry. */
const CUSTOM = "__custom__";

interface OllamaModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  selectClassName?: string;
  inputClassName?: string;
}

/**
 * Model picker for Ollama Cloud. Presents COMMON_OLLAMA_MODELS as a dropdown
 * (defaulting to Kimi) plus a "Custom…" option that reveals a text input for
 * any other model id — new models ship on Ollama Cloud regularly, so the
 * curated list is a convenience, not a hard allowlist.
 */
export function OllamaModelSelect({
  value,
  onChange,
  ariaLabel,
  selectClassName,
  inputClassName,
}: OllamaModelSelectProps) {
  const isKnown = COMMON_OLLAMA_MODELS.some((m) => m.id === value);
  // Start in custom mode when the saved value isn't one of the curated options
  // (e.g. a hand-typed model from before this dropdown existed) so the field
  // reflects what's actually stored. Sticky once set, so typing a known id
  // mid-edit doesn't yank the input out from under the user.
  const [custom, setCustom] = useState(!isKnown && value.length > 0);

  // If `value` is externally reset to a curated model (e.g. a settings reload)
  // while custom mode is on, drop back to the dropdown — otherwise the select
  // would show "Custom…" with a curated id in the text box, the opposite of
  // what's stored. Only fires when `value` actually changes, so it never
  // interferes with editing an unknown id.
  useEffect(() => {
    if (isKnown) setCustom(false);
  }, [value, isKnown]);

  const inCustomMode = custom || (!isKnown && value.length > 0);

  return (
    <div className="flex flex-col gap-1.5">
      <select
        aria-label={ariaLabel}
        value={inCustomMode ? CUSTOM : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            // Keep the current value; the user edits it in the revealed input.
            setCustom(true);
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
        className={selectClassName}
      >
        {COMMON_OLLAMA_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {inCustomMode && (
        <input
          type="text"
          value={value}
          placeholder={DEFAULT_OLLAMA_MODEL}
          aria-label={ariaLabel ? `${ariaLabel} — custom model id` : "Custom Ollama model id"}
          onChange={(e) => onChange(e.target.value)}
          className={inputClassName}
        />
      )}
    </div>
  );
}

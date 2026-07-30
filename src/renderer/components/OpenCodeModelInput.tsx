import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { OpenCodeModelOption } from "../../shared/types";

interface OpenCodeModelInputProps {
  value: string;
  onChange: (value: string) => void;
  models: OpenCodeModelOption[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  ariaLabel: string;
}

export function OpenCodeModelInput({
  value,
  onChange,
  models,
  loading,
  error,
  onRefresh,
  ariaLabel,
}: OpenCodeModelInputProps) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const available = models.some((model) => `${model.providerId}/${model.modelId}` === value);
  const filteredModels = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) =>
      [`${model.providerId}/${model.modelId}`, model.providerName, model.modelName].some(
        (candidate) => candidate.toLowerCase().includes(query),
      ),
    );
  }, [models, value]);
  const listOpen = suggestionsOpen && filteredModels.length > 0;
  const inputClassName =
    "w-48 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-500 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent";

  const selectModel = (model: OpenCodeModelOption) => {
    onChange(`${model.providerId}/${model.modelId}`);
    setSuggestionsOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setSuggestionsOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (filteredModels.length === 0) return;
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveIndex((current) => {
        if (event.key === "ArrowDown") {
          return (current + 1) % filteredModels.length;
        }
        return current > 0 && current < filteredModels.length
          ? current - 1
          : filteredModels.length - 1;
      });
      return;
    }
    if (
      event.key === "Enter" &&
      listOpen &&
      activeIndex >= 0 &&
      activeIndex < filteredModels.length
    ) {
      event.preventDefault();
      selectModel(filteredModels[activeIndex]);
    }
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-1.5"
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget)) {
          setSuggestionsOpen(false);
          setActiveIndex(-1);
        }
      }}
    >
      <div className="flex gap-1.5">
        <div className="relative">
          <input
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setSuggestionsOpen(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onClick={() => setSuggestionsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="OpenCode default"
            aria-label={ariaLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listId}
            aria-activedescendant={
              listOpen && activeIndex >= 0 && activeIndex < filteredModels.length
                ? `${listId}-option-${activeIndex}`
                : undefined
            }
            className={inputClassName}
          />
          {listOpen && (
            <div
              id={listId}
              role="listbox"
              aria-label="OpenCode model suggestions"
              className="absolute z-20 mt-1 max-h-64 w-80 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
            >
              {filteredModels.map((model, index) => {
                const selector = `${model.providerId}/${model.modelId}`;
                return (
                  <button
                    key={selector}
                    id={`${listId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectModel(model)}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      index === activeIndex
                        ? "bg-blue-50 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100"
                        : "text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    <span className="block font-medium">{selector}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {model.providerName} — {model.modelName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-500 rounded-lg text-gray-600 dark:text-gray-300 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh models"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {value && !loading && !error && !available && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Saved model is unavailable in OpenCode.
        </p>
      )}
    </div>
  );
}

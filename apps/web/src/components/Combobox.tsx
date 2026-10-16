"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface ComboboxOption {
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string;
}

export interface ComboboxProps {
  readonly label: string;
  readonly placeholder?: string;
  readonly options: readonly ComboboxOption[];
  readonly value: ComboboxOption | null;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (option: ComboboxOption) => void;
}

/**
 * Accessible single-select combobox: full keyboard operation (Arrow keys,
 * Home/End, Enter, Escape) with an ARIA listbox, so the whole wizard is
 * completable without a pointer.
 */
export function Combobox(props: ComboboxProps): React.JSX.Element {
  const listId = useId();
  // The visible text is the user's in-progress query while typing; otherwise it
  // mirrors the bound value, so a remount restores the selected label and a
  // cleared value (e.g. a draft reset) clears the input.
  const [typedQuery, setTypedQuery] = useState<string | null>(null);
  const query = typedQuery ?? props.value?.label ?? "";
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const disabled = props.disabled ?? false;

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const clampedActive = Math.min(activeIndex, Math.max(0, props.options.length - 1));

  function choose(option: ComboboxOption): void {
    props.onSelect(option);
    setTypedQuery(null);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, props.options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      setActiveIndex(0);
    } else if (event.key === "End") {
      setActiveIndex(Math.max(0, props.options.length - 1));
    } else if (event.key === "Enter") {
      const option = props.options[clampedActive];
      if (open && option) {
        event.preventDefault();
        choose(option);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1">
      <label htmlFor={`${listId}-input`} className="text-sm font-medium text-ink">
        {props.label}
      </label>
      <input
        id={`${listId}-input`}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && props.options[clampedActive] ? `${listId}-option-${clampedActive}` : undefined
        }
        className="rounded border border-border bg-paper px-3 py-2 text-ink"
        placeholder={props.placeholder}
        autoComplete="off"
        disabled={disabled}
        value={query}
        onChange={(event) => {
          setTypedQuery(event.target.value);
          props.onQueryChange(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
          }
        }}
        onKeyDown={onKeyDown}
      />
      {props.value ? <p className="text-xs text-ink-muted">Selected: {props.value.label}</p> : null}
      <p aria-live="polite" role="status" className="sr-only">
        {open
          ? props.loading
            ? "Loading results"
            : `${props.options.length} results available`
          : ""}
      </p>
      {open && !disabled && (props.options.length > 0 || props.loading) ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={props.label}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded border border-border bg-paper shadow-lg top-full"
        >
          {props.options.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === clampedActive}
              className={`cursor-pointer px-3 py-2 ${
                index === clampedActive ? "bg-teal text-paper" : "text-ink"
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              <span className="block text-sm">{option.label}</span>
              {option.sublabel ? (
                <span className="block text-xs opacity-80">{option.sublabel}</span>
              ) : null}
            </li>
          ))}
          {props.loading ? <li className="px-3 py-2 text-xs text-ink-muted">Loading…</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

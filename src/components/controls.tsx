// The five control families of the options panel (contract §4.3):
// scalar (bool/int/uint/string), enum, map, list<string> and list<struct>.
//
// Every control is a controlled component: the displayed value is derived from
// `modified` + the preset defaults by the caller (`effectiveValue`), and edits
// are reported upward. `undefined` always means "remove the explicit value"
// (inherit from the preset style); the one exception is a string field inside a
// struct item, where an empty string is a legal explicit value.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  effectiveChildValue,
  effectiveValue,
  formatValue,
  isPlainObject,
  type Modified,
} from "../lib/config";
import type { Field, OptionDef, OptionType, StyleName } from "../lib/schema";
import styles from "./OptionPanel.module.css";

type NumberScalar = "int" | "uint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep only the strings of an `unknown` list value. */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const list: string[] = [];
  for (const item of value) {
    if (typeof item === "string") list.push(item);
  }
  return list;
}

/** textarea text -> list value (blank lines ignored). */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function parseNumber(text: string, scalar: NumberScalar): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return null;
  if (scalar === "uint" && parsed < 0) return null;
  return parsed;
}

/** Empty struct item: omit scalar/enum fields, use [] for list fields. */
function emptyStructValue(fields: Field[]): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type.kind === "list" && field.type.item === "string") {
      value[field.key] = [];
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function BoolControl({
  testId,
  ariaLabel,
  value,
  onChange,
}: {
  testId: string;
  ariaLabel: string;
  value: unknown;
  onChange: (next: unknown) => void;
}): JSX.Element {
  const checked = value === true;
  return (
    <label className={styles.checkbox}>
      <input
        type="checkbox"
        data-testid={testId}
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.checkboxText}>{checked ? "true" : "false"}</span>
    </label>
  );
}

export function NumberControl({
  testId,
  ariaLabel,
  value,
  onChange,
  scalar,
}: {
  testId: string;
  ariaLabel: string;
  value: unknown;
  onChange: (next: unknown) => void;
  scalar: NumberScalar;
}): JSX.Element {
  const external = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(external);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(external);
  }, [external]);

  const handleChange = (text: string): void => {
    setDraft(text);
    const next = parseNumber(text, scalar);
    if (next === null) return; // invalid while typing: keep the draft, commit nothing
    const current = typeof value === "number" ? value : undefined;
    if (next !== current) onChange(next);
  };

  return (
    <input
      className={styles.input}
      data-testid={testId}
      aria-label={ariaLabel}
      type="number"
      inputMode="numeric"
      step={1}
      min={scalar === "uint" ? 0 : undefined}
      value={draft}
      onChange={(event) => handleChange(event.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setDraft(typeof value === "number" ? String(value) : "");
      }}
    />
  );
}

export function StringControl({
  testId,
  ariaLabel,
  value,
  onChange,
  explicitEmpty = false,
}: {
  testId: string;
  ariaLabel: string;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Struct fields: "" is a legal explicit value instead of "inherit". */
  explicitEmpty?: boolean;
}): JSX.Element {
  const external = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(external);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(external);
  }, [external]);

  const handleChange = (text: string): void => {
    setDraft(text);
    if (text === "" && !explicitEmpty) {
      if (value !== undefined) onChange(undefined);
      return;
    }
    if (text !== value) onChange(text);
  };

  return (
    <input
      className={styles.input}
      data-testid={testId}
      aria-label={ariaLabel}
      type="text"
      spellCheck={false}
      autoComplete="off"
      value={draft}
      onChange={(event) => handleChange(event.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setDraft(typeof value === "string" ? value : "");
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

export function EnumControl({
  testId,
  ariaLabel,
  values,
  selectedValue,
  emptyLabel,
  onChange,
}: {
  testId: string;
  ariaLabel: string;
  values: string[];
  /** "" = no explicit value (show the empty/inherit entry). */
  selectedValue: string;
  emptyLabel: string;
  onChange: (next: unknown) => void;
}): JSX.Element {
  const known = selectedValue === "" || values.includes(selectedValue);
  return (
    <select
      className={styles.select}
      data-testid={testId}
      aria-label={ariaLabel}
      value={selectedValue}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === "" ? undefined : next);
      }}
    >
      <option value="">{emptyLabel}</option>
      {values.map((value) => (
        <option key={value} value={value}>
          {value}
        </option>
      ))}
      {!known && <option value={selectedValue}>{selectedValue}</option>}
    </select>
  );
}

// ---------------------------------------------------------------------------
// list<string>
// ---------------------------------------------------------------------------

export function LinesControl({
  testId,
  ariaLabel,
  value,
  onChange,
  emptyAsInherit,
  rows = 4,
  placeholder,
}: {
  testId: string;
  ariaLabel: string;
  value: unknown;
  onChange: (next: string[] | undefined) => void;
  /** true: all lines removed => restore inherit (top level); false: store []. */
  emptyAsInherit: boolean;
  rows?: number;
  placeholder?: string;
}): JSX.Element {
  const external = toStringList(value).join("\n");
  const [draft, setDraft] = useState(external);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(external);
  }, [external]);

  const commit = (text: string): void => {
    const lines = splitLines(text);
    if (lines.length === 0 && emptyAsInherit) onChange(undefined);
    else onChange(lines);
  };

  return (
    <textarea
      className={styles.textarea}
      data-testid={testId}
      aria-label={ariaLabel}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder ?? "One value per line"}
      value={draft}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        commit(text);
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setDraft(external);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Generic field dispatcher (top level, map children and struct items)
// ---------------------------------------------------------------------------

export type FieldValueControlProps = {
  type: OptionType;
  value: unknown;
  /** Preset (inherited) value, used for the enum "Inherit (…)" label. */
  preset: unknown;
  /** Whether the value is explicitly stored (enum: show it instead of Inherit). */
  overridden: boolean;
  onChange: (next: unknown) => void;
  testId: string;
  ariaLabel: string;
  /** Struct item field: "" is an explicit string value, enums start unset. */
  fieldMode?: boolean;
};

export function FieldValueControl({
  type,
  value,
  preset,
  overridden,
  onChange,
  testId,
  ariaLabel,
  fieldMode = false,
}: FieldValueControlProps): JSX.Element | null {
  if (type.kind === "scalar") {
    if (type.scalar === "bool") {
      return <BoolControl testId={testId} ariaLabel={ariaLabel} value={value} onChange={onChange} />;
    }
    if (type.scalar === "string") {
      return (
        <StringControl
          testId={testId}
          ariaLabel={ariaLabel}
          value={value}
          onChange={onChange}
          explicitEmpty={fieldMode}
        />
      );
    }
    return (
      <NumberControl
        testId={testId}
        ariaLabel={ariaLabel}
        value={value}
        onChange={onChange}
        scalar={type.scalar}
      />
    );
  }

  if (type.kind === "enum") {
    return (
      <EnumControl
        testId={testId}
        ariaLabel={ariaLabel}
        values={type.values}
        selectedValue={overridden && typeof value === "string" ? value : ""}
        emptyLabel={fieldMode ? "—" : `Inherit (${formatValue(preset)})`}
        onChange={onChange}
      />
    );
  }

  if (type.kind === "list" && type.item === "string") {
    return (
      <LinesControl
        testId={testId}
        ariaLabel={ariaLabel}
        value={value}
        onChange={onChange}
        emptyAsInherit={!fieldMode}
        rows={fieldMode ? 2 : 4}
      />
    );
  }

  // Nested maps / struct lists do not exist in the generated schema; render a
  // read-only summary instead of pretending to edit them.
  return <span className={styles.summary}>{formatValue(value)}</span>;
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

export type MapControlProps = {
  option: OptionDef;
  style: StyleName;
  modified: Modified;
  onChildChange: (option: OptionDef, childKey: string, value: unknown) => void;
};

export function MapControl({
  option,
  style,
  modified,
  onChildChange,
}: MapControlProps): JSX.Element | null {
  const type = option.type;
  if (type.kind !== "map") return null;
  const children: Field[] = type.children;
  const preset = option.defaults[style];
  const override = modified[option.key];
  const patch = isPlainObject(override) ? override : {};

  return (
    <div className={styles.children}>
      {children.map((child) => {
        const path = `${option.key}.${child.key}`;
        const childValue = effectiveChildValue(option, child.key, style, modified);
        const childPreset = isPlainObject(preset) ? preset[child.key] : undefined;
        const childOverridden = Object.hasOwn(patch, child.key);
        return (
          <div className={styles.childRow} key={child.key}>
            <div className={styles.childHead}>
              <span className={styles.childKey}>{child.key}</span>
              {childOverridden && (
                <button
                  type="button"
                  className={styles.iconButton}
                  data-testid={`reset-child-${path}`}
                  aria-label={`Reset ${path}`}
                  onClick={() => onChildChange(option, child.key, undefined)}
                >
                  Reset
                </button>
              )}
            </div>
            <div className={styles.childControl}>
              <FieldValueControl
                type={child.type}
                value={childValue}
                preset={childPreset}
                overridden={childOverridden}
                onChange={(next) => onChildChange(option, child.key, next)}
                testId={`value-${path}`}
                ariaLabel={path}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// list<struct>
// ---------------------------------------------------------------------------

export type StructListControlProps = {
  option: OptionDef;
  style: StyleName;
  modified: Modified;
  onOptionChange: (key: string, value: unknown) => void;
};

export function StructListControl({
  option,
  style,
  modified,
  onOptionChange,
}: StructListControlProps): JSX.Element | null {
  const type = option.type;
  if (type.kind !== "list" || type.item !== "struct") return null;
  const fields: Field[] = type.fields;
  const effective = effectiveValue(option, style, modified);
  const items: unknown[] = Array.isArray(effective) ? effective : [];

  const commit = (next: unknown[]): void => onOptionChange(option.key, next);

  const updateField = (index: number, fieldKey: string, next: unknown): void => {
    commit(
      items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const record = isPlainObject(item) ? { ...item } : {};
        if (next === undefined) delete record[fieldKey];
        else record[fieldKey] = next;
        return record;
      }),
    );
  };

  return (
    <div className={styles.children}>
      {items.map((item, index) => {
        const record = isPlainObject(item) ? item : {};
        return (
          <div className={styles.itemCard} key={index} data-testid={`item-${option.key}-${index}`}>
            <div className={styles.itemHead}>
              <span className={styles.itemTitle}>{`Item ${index + 1}`}</span>
              <button
                type="button"
                className={styles.iconButton}
                data-testid={`remove-item-${option.key}-${index}`}
                aria-label={`Remove item ${index + 1}`}
                onClick={() => commit(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                Remove
              </button>
            </div>
            {fields.map((field) => {
              const path = `${option.key}.${index}.${field.key}`;
              return (
                <div className={styles.childRow} key={field.key}>
                  <div className={styles.childHead}>
                    <span className={styles.childKey}>{field.key}</span>
                  </div>
                  <div className={styles.childControl}>
                    <FieldValueControl
                      type={field.type}
                      value={record[field.key]}
                      preset={undefined}
                      overridden
                      fieldMode
                      onChange={(next) => updateField(index, field.key, next)}
                      testId={`value-${path}`}
                      ariaLabel={path}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      <button
        type="button"
        className={styles.addButton}
        data-testid={`add-item-${option.key}`}
        onClick={() => commit([...items, emptyStructValue(fields)])}
      >
        Add item
      </button>
    </div>
  );
}

// One row of the options panel (contract §4.2): key + badges, control, docs
// toggle, per-row reset and the "inherited" hint. The row itself is never
// clickable — every affordance is a native control or a button.
//
// M4: the row is the unit of the roving keyboard model. Exactly one row (the
// active one) carries `tabIndex={0}`; it is a list item so screen readers know
// how far through the (virtualized) option set they are, and it owns the
// arrow/Home/End/PageUp/PageDown keys while it — not one of its controls — has
// focus. Enter/Space on the row toggles its documentation.

import { useMemo } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  effectiveValue,
  formatValue,
  isModified,
  isPlainObject,
  type Modified,
} from "../lib/config";
import type { OptionDef, SchemaCore, SchemaDocs, StyleName } from "../lib/schema";
import {
  FieldValueControl,
  LinesControl,
  MapControl,
  StructListControl,
} from "./controls";
import { rovingTabIndex } from "./roving";
import { prepareDocsHtml, type DocsStatus } from "./useDocs";
import styles from "./OptionPanel.module.css";

export type OptionRowProps = {
  schema: SchemaCore;
  option: OptionDef;
  style: StyleName;
  modified: Modified;
  /** This is the single Tab stop of the virtualized list. */
  active: boolean;
  /** 1-based position of this row in the currently visible option set. */
  posInSet: number;
  /** Number of currently visible options (virtualization hides most rows). */
  setSize: number;
  docsOpen: boolean;
  bodyOpen: boolean;
  docs: SchemaDocs | null;
  docsStatus: DocsStatus;
  docsError: string | null;
  /** Arrow/Home/End/PageUp/PageDown pressed while the row itself has focus. */
  onNavigate: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** Focus entered the row (the row itself or one of its controls). */
  onFocusRow: (key: string) => void;
  onToggleDocs: (key: string) => void;
  onToggleBody: (key: string) => void;
  onRetryDocs: () => void;
  onOptionChange: (key: string, value: unknown) => void;
  onChildChange: (option: OptionDef, childKey: string, value: unknown) => void;
};

/**
 * Options that only take effect when a sibling option selects `Custom` (plan §5
 * "override 警告"). Editing them while the parent still holds another value is
 * legal but silently ignored by clang-format, so the row warns and offers a
 * one-click fix.
 */
const OVERRIDE_GUARDS: Readonly<Record<string, { option: string; required: string }>> = {
  BraceWrapping: { option: "BreakBeforeBraces", required: "Custom" },
  SpaceBeforeParensOptions: { option: "SpaceBeforeParens", required: "Custom" },
};

/** Short status shown in front of the expand button for map/list options. */
function summarize(option: OptionDef, modified: Modified, value: unknown): string {
  if (option.type.kind === "map") {
    const override = modified[option.key];
    const patch = isPlainObject(override) ? override : {};
    const changed = Object.keys(patch).length;
    return changed === 0 ? "inherited" : `${changed} changed`;
  }
  const count = Array.isArray(value) ? value.length : 0;
  return `${count} item${count === 1 ? "" : "s"}`;
}

export default function OptionRow({
  schema,
  option,
  style,
  modified,
  active,
  posInSet,
  setSize,
  docsOpen,
  bodyOpen,
  docs,
  docsStatus,
  docsError,
  onNavigate,
  onFocusRow,
  onToggleDocs,
  onToggleBody,
  onRetryDocs,
  onOptionChange,
  onChildChange,
}: OptionRowProps): JSX.Element {
  const key = option.key;
  const type = option.type;
  const overridden = isModified(modified, key);
  const value = effectiveValue(option, style, modified);
  const preset = option.defaults[style];
  const collapsible = type.kind === "map" || type.kind === "list";
  const docsHtml = docs === null ? undefined : docs[key];
  // Render-layer docs fix (M4): focusable <pre> blocks and no leaked RST markers.
  const docsMarkup = useMemo(() => (docsHtml === undefined ? "" : prepareDocsHtml(docsHtml)), [docsHtml]);

  const guard = OVERRIDE_GUARDS[key];
  const guardOption = guard === undefined ? undefined : schema.options.find((entry) => entry.key === guard.option);
  const guardValue = guard !== undefined && guardOption !== undefined ? effectiveValue(guardOption, style, modified) : undefined;
  const showOverrideWarning =
    overridden && guard !== undefined && guardOption !== undefined && guardValue !== guard.required;

  // Ids referenced by the expander/docs toggles via aria-controls. The target
  // elements only exist while their section is open, so the attribute is set
  // conditionally to keep every reference resolvable.
  const bodyId = `option-body-${key}`;
  const docsId = `option-docs-${key}`;

  // The active row is the list's Tab stop; the accessible name stays short
  // because the row also contains several controls that are each announced.
  const rowLabel = `${key}${option.deprecated ? ", deprecated" : ""}${overridden ? ", modified" : ""}`;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Only the row itself owns list navigation: arrow keys inside a number or
    // text control must keep their native behaviour (caret/stepper), and Space
    // on a button must activate the button.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleDocs(key);
      return;
    }
    onNavigate(event);
  };

  let control: JSX.Element | null;
  if (type.kind === "map") {
    control = <span className={styles.summary}>{summarize(option, modified, value)}</span>;
  } else if (type.kind === "list") {
    control = <span className={styles.summary}>{summarize(option, modified, value)}</span>;
  } else {
    control = (
      <FieldValueControl
        type={type}
        value={value}
        preset={preset}
        overridden={overridden}
        onChange={(next) => onOptionChange(key, next)}
        testId={`value-${key}`}
        ariaLabel={key}
      />
    );
  }

  let body: JSX.Element | null = null;
  if (collapsible && bodyOpen) {
    if (type.kind === "map") {
      body = (
        <MapControl
          option={option}
          style={style}
          modified={modified}
          onChildChange={onChildChange}
        />
      );
    } else if (type.item === "string") {
      body = (
        <LinesControl
          testId={`value-${key}`}
          ariaLabel={key}
          value={value}
          onChange={(next) => onOptionChange(key, next)}
          emptyAsInherit
          rows={5}
        />
      );
    } else {
      body = (
        <StructListControl
          option={option}
          style={style}
          modified={modified}
          onOptionChange={onOptionChange}
        />
      );
    }
  }

  return (
    <div
      className={styles.row}
      data-testid={`option-${key}`}
      role="listitem"
      aria-label={rowLabel}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      tabIndex={rovingTabIndex(active)}
      onKeyDown={handleKeyDown}
      onFocus={() => onFocusRow(key)}
    >
      <div className={styles.top}>
        <div className={styles.identity}>
          <span className={styles.key}>{key}</span>
          {option.deprecated && <span className={styles.badgeDeprecated}>deprecated</span>}
          {overridden && (
            <span className={styles.badgeModified} data-testid={`modified-badge-${key}`}>
              modified
            </span>
          )}
        </div>
        <div className={styles.actions}>
          {collapsible && (
            <button
              type="button"
              className={styles.iconButton}
              data-testid={`expand-${key}`}
              aria-expanded={bodyOpen}
              aria-controls={bodyOpen ? bodyId : undefined}
              aria-label={`${bodyOpen ? "Collapse" : "Edit"} ${key}`}
              onClick={() => onToggleBody(key)}
            >
              {bodyOpen ? "Collapse" : "Edit"}
            </button>
          )}
          <button
            type="button"
            // The toggle keeps its "Docs" label, so the open state is signalled
            // by colour: accent-filled while this row's documentation is open
            // (see .iconButton.docsButtonOpen in OptionPanel.module.css).
            className={docsOpen ? `${styles.iconButton} ${styles.docsButtonOpen}` : styles.iconButton}
            data-testid={`docs-${key}`}
            aria-expanded={docsOpen}
            aria-controls={docsOpen ? docsId : undefined}
            aria-label={`Docs for ${key}`}
            onClick={() => onToggleDocs(key)}
          >
            Docs
          </button>
          {overridden && (
            <button
              type="button"
              className={styles.iconButton}
              data-testid={`reset-${key}`}
              aria-label={`Reset ${key}`}
              onClick={() => onOptionChange(key, undefined)}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div className={styles.controlRow}>{control}</div>

      {overridden && (
        <div className={styles.inherited} data-testid={`inherited-${key}`}>
          {`Inherited: ${formatValue(preset)}`}
        </div>
      )}

      {showOverrideWarning && guard !== undefined && guardOption !== undefined && (
        <div className={styles.overrideWarning} data-testid={`override-warning-${key}`} role="status">
          <span id={`override-warning-text-${key}`}>
            {`${key} only takes effect when ${guard.option} is ${guard.required}; the current value is ${formatValue(
              guardValue,
            )}.`}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            data-testid={`apply-guard-${key}`}
            aria-describedby={`override-warning-text-${key}`}
            onClick={() => onOptionChange(guard.option, guard.required)}
          >
            {`Set ${guard.option}: ${guard.required}`}
          </button>
        </div>
      )}

      {body !== null && <div id={bodyId}>{body}</div>}

      {docsOpen && (
        <div className={styles.docs} id={docsId}>
          {docsStatus === "ready" && docsHtml !== undefined && (
            <div
              className={styles.docsContent}
              data-testid={`docs-content-${key}`}
              // Docs HTML is generated at build time from the LLVM RST sources
              // and committed with the schema; no runtime input is involved.
              // `prepareDocsHtml` only adds `tabindex` to <pre> blocks and
              // normalizes leaked RST markers; it never decodes entities.
              dangerouslySetInnerHTML={{ __html: docsMarkup }}
            />
          )}
          {docsStatus === "ready" && docsHtml === undefined && (
            <div className={styles.docsStatus}>No documentation for this option.</div>
          )}
          {docsStatus === "loading" && <div className={styles.docsStatus}>Loading docs…</div>}
          {docsStatus === "idle" && <div className={styles.docsStatus}>Loading docs…</div>}
          {docsStatus === "error" && (
            <div className={styles.docsError} role="alert">
              <span>{docsError ?? "Failed to load the documentation."}</span>
              <button
                type="button"
                className={styles.iconButton}
                data-testid={`docs-retry-${key}`}
                aria-label={`Retry loading documentation for ${key}`}
                onClick={onRetryDocs}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

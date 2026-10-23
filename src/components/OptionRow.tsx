// One row of the options panel (contract §4.2): key + badges, control, docs
// toggle, per-row reset and the "inherited" hint. The row itself is never
// clickable — every affordance is a native control or a button.

import type { JSX } from "react";

import {
  effectiveValue,
  formatValue,
  isModified,
  isPlainObject,
  type Modified,
} from "../lib/config";
import type { OptionDef, SchemaDocs, StyleName } from "../lib/schema";
import {
  FieldValueControl,
  LinesControl,
  MapControl,
  StructListControl,
} from "./controls";
import type { DocsStatus } from "./useDocs";
import styles from "./OptionPanel.module.css";

export type OptionRowProps = {
  option: OptionDef;
  style: StyleName;
  modified: Modified;
  docsOpen: boolean;
  bodyOpen: boolean;
  docs: SchemaDocs | null;
  docsStatus: DocsStatus;
  docsError: string | null;
  onToggleDocs: (key: string) => void;
  onToggleBody: (key: string) => void;
  onRetryDocs: () => void;
  onOptionChange: (key: string, value: unknown) => void;
  onChildChange: (option: OptionDef, childKey: string, value: unknown) => void;
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
  option,
  style,
  modified,
  docsOpen,
  bodyOpen,
  docs,
  docsStatus,
  docsError,
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
    <div className={styles.row} data-testid={`option-${key}`}>
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
              onClick={() => onToggleBody(key)}
            >
              {bodyOpen ? "Collapse" : "Edit"}
            </button>
          )}
          <button
            type="button"
            className={styles.iconButton}
            data-testid={`docs-${key}`}
            aria-expanded={docsOpen}
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

      {body}

      {docsOpen && (
        <div className={styles.docs}>
          {docsStatus === "ready" && docsHtml !== undefined && (
            <div
              className={styles.docsContent}
              data-testid={`docs-content-${key}`}
              // Docs HTML is generated at build time from the LLVM RST sources
              // and committed with the schema; no runtime input is involved.
              dangerouslySetInnerHTML={{ __html: docsHtml }}
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

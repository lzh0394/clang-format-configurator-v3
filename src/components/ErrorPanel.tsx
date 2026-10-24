import styles from "./ErrorPanel.module.css";

export type ErrorPanelProps = {
  /** One-line headline, e.g. `Error parsing -style: Invalid argument`. */
  message: string;
  /** Full LLVM diagnostics; rendered in an expandable `<details>`. */
  detail?: string;
  onDismiss?: () => void;
};

/**
 * Structured error display: a one-line summary plus the raw LLVM diagnostics
 * behind a disclosure, replacing the old "dump the whole stderr blob" panel.
 * Parent owns the error state; this component is purely presentational.
 */
export default function ErrorPanel({ message, detail, onDismiss }: ErrorPanelProps) {
  const hasDetail = Boolean(detail && detail.trim().length > 0);

  return (
    <div className={styles.panel} data-testid="error-panel">
      <div className={styles.summaryRow}>
        <strong className={styles.summary} role="alert" data-testid="error-summary">
          {message}
        </strong>
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss error"
          data-testid="error-dismiss"
        >
          ×
        </button>
      </div>

      {hasDetail && (
        <details className={styles.details} data-testid="error-detail">
          <summary className={styles.detailsSummary}>LLVM diagnostics</summary>
          <pre className={styles.pre}>{detail}</pre>
        </details>
      )}
    </div>
  );
}

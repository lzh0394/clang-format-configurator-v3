import { useEffect, useState } from "react";

import { getInstallController, shouldShowInstallBanner, type InstallState } from "./install";
import styles from "./InstallBanner.module.css";

/** Nothing is installable until a `beforeinstallprompt` event arrives. */
const NO_INSTALL: InstallState = { canInstall: false, installed: false, dismissed: false };

/**
 * Install banner for the PWA (M4, plan §9 "安装提示").
 *
 * Self-contained: it subscribes to the install controller (`install.ts`) and
 * renders itself only while the browser has a pending, not-dismissed
 * `beforeinstallprompt` event. Nothing needs to be wired through props, so the
 * app only has to render `<InstallBanner />` once inside its layout.
 *
 * Accessibility: the region has an accessible name, the close button has an
 * explicit label, and the install action reports its busy state through
 * `aria-busy`/`disabled`.
 */
export function InstallBanner() {
  const [state, setState] = useState<InstallState>(NO_INSTALL);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = getInstallController();
    if (controller === null) return;
    // The event may have been captured before this component mounted.
    setState(controller.getState());
    return controller.subscribe(() => setState(controller.getState()));
  }, []);

  if (!shouldShowInstallBanner(state)) return null;

  const install = (): void => {
    const controller = getInstallController();
    if (controller === null) return;
    setBusy(true);
    void controller.promptInstall().finally(() => setBusy(false));
  };

  const dismiss = (): void => {
    getInstallController()?.dismiss();
  };

  return (
    <section className={styles.banner} role="region" aria-label="Install app" data-testid="install-banner">
      <div className={styles.body}>
        <strong className={styles.title}>Install the configurator</strong>
        <span className={styles.hint}>
          Add it to this device for instant offline access — no browser window needed.
        </span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={install}
          disabled={busy}
          aria-busy={busy}
          data-testid="install-button"
        >
          {busy ? "Installing…" : "Install"}
        </button>
        <button
          type="button"
          className={styles.dismiss}
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          data-testid="install-dismiss"
        >
          ×
        </button>
      </div>
    </section>
  );
}

export default InstallBanner;

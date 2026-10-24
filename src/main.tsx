import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getInstallController } from "./pwa/install";
import "./styles.css";

// Capture `beforeinstallprompt` before React renders: the banner component only
// mounts after the first commit, and a fast browser can fire the event earlier.
getInstallController();

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyStoredAppearance } from "./app/appearance";
import { App } from "./App";
import { detectPlatform } from "./lib/platform";
import "./styles.css";

// The theme and the text size of this browser apply before the first frame, so the page never
// flashes the wrong ones (an inline script would be refused by the server's Content-Security-Policy).
applyStoredAppearance();
// The fonts of the browser's system (src/styles.css) apply before the first frame too.
document.documentElement.dataset.platform = detectPlatform();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

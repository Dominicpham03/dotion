import "@fontsource-variable/source-serif-4"; // bundled, never from a CDN: works offline and under CSP 'self'
import "@fontsource-variable/figtree"; // interface font
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { applyTheme } from "@/lib/theme";
import "./index.css";

applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

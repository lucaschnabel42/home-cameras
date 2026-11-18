import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./styles.css";
import App from "./App";
import { applyTheme, readTheme } from "./lib/theme";

// index.html set data-theme before the first paint; this also sets the browser bar colour.
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

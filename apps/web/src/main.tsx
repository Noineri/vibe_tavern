import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import { LocaleProvider } from "./i18n/context.js";
import "./styles.css";

const savedLang = (() => {
  try {
    const raw = localStorage.getItem("rp-tweaks");
    if (raw) { const parsed = JSON.parse(raw); if (parsed.lang === "ru" || parsed.lang === "en") return parsed.lang; }
  } catch { /* ignore */ }
  return "en";
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider initialLocale={savedLang}>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import { LocaleProvider, type Locale } from "./i18n/context.js";
import "./styles.css";

function detectLocale(): Locale {
  // 1. Explicit user choice (saved in TweaksPanel) takes priority
  try {
    const raw = localStorage.getItem("rp-platform.tweaks");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.lang === "ru" || parsed.lang === "en") return parsed.lang;
    }
  } catch { /* ignore */ }

  // 2. Auto-detect from browser language
  const nav = navigator.language ?? "";
  if (nav.startsWith("ru")) return "ru";

  // 3. Default
  return "en";
}

const initialLocale = detectLocale();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider initialLocale={initialLocale}>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);

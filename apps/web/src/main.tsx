import React from "react";
import { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./lib/register-core-panels.jsx";
import { LocaleProvider } from "./i18n/context.js";
import { isLocale, detectBrowserLocale, type Locale } from "./i18n/registry.js";
import { ThemeTuner } from "./components/dev/ThemeTuner.js";
import "./styles.css";

function detectLocale(): Locale {
  // 1. Explicit user choice (saved in TweaksPanel) takes priority
  try {
    const raw = localStorage.getItem("vibe-tavern.tweaks");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isLocale(parsed.lang)) return parsed.lang;
    }
  } catch { /* ignore */ }

  // 2. Auto-detect from browser language, falling back to the default locale
  //    inside detectBrowserLocale when nothing matches.
  return detectBrowserLocale(navigator.language ?? "");
}

const initialLocale = detectLocale();

/**
 * Top-level router. The app has no real router (single-page), but the dev
 * ThemeTuner is exposed at `#theme-tuner` so it can be opened directly without
 * loading the full app (and without needing the backend). When the hash
 * changes we re-render so entering/leaving the tuner is instant.
 */
function Root() {
  const [isTuner, setIsTuner] = useState(() => window.location.hash === "#theme-tuner");
  useEffect(() => {
    const onHash = () => setIsTuner(window.location.hash === "#theme-tuner");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return isTuner ? <ThemeTuner /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider initialLocale={initialLocale}>
      <Root />
    </LocaleProvider>
  </React.StrictMode>,
);

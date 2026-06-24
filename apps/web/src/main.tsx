import React from "react";
import { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./lib/register-core-panels.jsx";
import { LocaleProvider } from "./i18n/context.js";
import { isLocale, detectBrowserLocale, type Locale } from "./i18n/registry.js";
import { ThemeTuner } from "./components/dev/ThemeTuner.js";
import { VibeMdThemePreview } from "./components/build/editors/VibeMdThemePreview.js";
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
 * Top-level router. The app has no real router (single-page), but dev surfaces
 * are exposed at hash anchors so they can be opened directly without loading
 * the full app (and without needing the backend):
 *  - `#theme-tuner` — live theme variable editor.
 *  - `#vtf-preview` — Vibe MD amber-theme preview (TEMPORARY, VTF-10; remove
 *    once VTF-13 ships the real editor).
 * When the hash changes we re-render so entering/leaving is instant.
 */
function Root() {
  const [view, setView] = useState<"app" | "tuner" | "vtf">(() => {
    if (window.location.hash === "#theme-tuner") return "tuner";
    if (window.location.hash === "#vtf-preview") return "vtf";
    return "app";
  });
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === "#theme-tuner") setView("tuner");
      else if (window.location.hash === "#vtf-preview") setView("vtf");
      else setView("app");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (view === "tuner") return <ThemeTuner />;
  if (view === "vtf") return <VibeMdThemePreview />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider initialLocale={initialLocale}>
      <Root />
    </LocaleProvider>
  </React.StrictMode>,
);

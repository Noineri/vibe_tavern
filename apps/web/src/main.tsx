import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app.js";
import "./lib/register-core-panels.jsx";
import { LocaleProvider, type Locale } from "./i18n/context.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

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
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale={initialLocale}>
        <App />
      </LocaleProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

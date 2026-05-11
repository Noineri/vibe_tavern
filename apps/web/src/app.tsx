import { useRpPlatformApp } from "./hooks/use-rp-platform-app.js";
import { useT } from "./i18n/context.js";
import { AppShellProvider, AppShell } from "./components/AppShell.js";

export { useAppActions } from "./components/AppShell.js";

export function App() {
  const { t } = useT();
  const app = useRpPlatformApp();

  if (app.isLoading) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div className="font-body text-[12.5px] italic text-t3">{t("loading_app")}</div>
        </main>
      </div>
    );
  }

  if (app.loadError) {
    return (
      <div className="flex h-screen overflow-hidden bg-bg text-t1 font-ui">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden">
          <div style={{ display: "grid", gap: 12, maxWidth: 420, padding: 24 }}>
            <div className="build-section-title">{t("bootstrap_failed")}</div>
            <div className="build-section-sub">{app.loadError}</div>
            <button className="api-save-btn" onClick={() => void app.loadBootstrap()}>
              {t("retry")}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <AppShellProvider app={app}>
      <AppShell />
    </AppShellProvider>
  );
}

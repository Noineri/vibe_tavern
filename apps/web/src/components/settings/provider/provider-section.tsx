import type { ReactNode } from "react";
import { useT, type TFunc } from "../../../i18n/context.js";

/**
 * forks: 0 — provider-family section-shell source.
 *
 * Family data and list behavior remain with the consumer; this owns only the
 * shared loading, error, and master-list chrome.
 */
export interface ProviderSectionProps {
  testidStem: string;
  titleKey: Parameters<TFunc>[0];
  loadingKey: Parameters<TFunc>[0];
  errorKey: Parameters<TFunc>[0];
  loading: boolean;
  error: string | null;
  children: ReactNode;
}

export function ProviderSection({
  testidStem,
  titleKey,
  loadingKey,
  errorKey,
  loading,
  error,
  children,
}: ProviderSectionProps) {
  const { t } = useT();

  if (loading) {
    return (
      <div data-testid={`${testidStem}-section`} className="flex flex-col p-3">
        <div className="mb-3 font-ui text-[12px] font-semibold uppercase tracking-wide text-t3">
          {t(titleKey)}
        </div>
        <div className="font-ui text-[13px] text-t3">{t(loadingKey)}</div>
      </div>
    );
  }

  return (
    <div data-testid={`${testidStem}-section`} className="flex flex-col flex-1 min-h-0">
      {error && (
        <div data-testid={`${testidStem}-load-error`} className="mx-3 mt-2 rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {t(errorKey)}: {error}
        </div>
      )}
      {children}
    </div>
  );
}

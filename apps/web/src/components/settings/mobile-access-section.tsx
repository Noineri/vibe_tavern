import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { apiFetch } from "../../api/client.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";

interface MobileAccessInfo {
  ips: { address: string; type: "primary" | "tailscale" | "fallback"; interfaceName: string }[];
  port: number;
  token: string | null;
  tlsEnabled: boolean;
}

/** The original QR/address/token body, without a modal shell or automatic enabling. */
export function MobileAccessSection({ onDisabled }: { onDisabled?: () => void }) {
  const { t } = useT();
  const [info, setInfo] = useState<MobileAccessInfo | null>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const active = useRef(false);
  const revision = useRef(0);
  const copyTimer = useRef<number | null>(null);
  const clearCopyFeedback = useCallback(() => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = null;
  }, []);

  const fetchInfo = useCallback(async () => {
    const request = ++revision.current;
    setBusy(true); setError(false);
    try {
      const response = await apiFetch("/api/settings/mobile-access");
      if (!response.ok) throw new Error("Mobile access request failed");
      const data: MobileAccessInfo = await response.json();
      const primary = data.ips[0];
      const svg = primary && data.token
        ? await QRCode.toString(`${data.tlsEnabled ? "https" : "http"}://${primary.address}:${data.port}/#token=${encodeURIComponent(data.token)}`, { type: "svg", width: 200, margin: 1 })
        : "";
      if (!active.current || request !== revision.current) return;
      clearCopyFeedback(); setCopied(null); setShowToken(false);
      setInfo(data); setQrSvg(svg);
    } catch {
      if (active.current && request === revision.current) setError(true);
    } finally {
      if (active.current && request === revision.current) setBusy(false);
    }
  }, [clearCopyFeedback]);

  useEffect(() => {
    active.current = true;
    void fetchInfo();
    return () => { active.current = false; revision.current++; clearCopyFeedback(); };
  }, [fetchInfo, clearCopyFeedback]);

  const copyToClipboard = async (text: string, id: string) => {
    const request = revision.current;
    try {
      await navigator.clipboard.writeText(text);
      if (!active.current || request !== revision.current) return;
      clearCopyFeedback(); setCopied(id);
      copyTimer.current = window.setTimeout(() => { copyTimer.current = null; setCopied(null); }, 2000);
    } catch {
      if (active.current && request === revision.current) setError(true);
    }
  };

  const mutate = async (action: "enable" | "regenerate" | "disable") => {
    if (busy) return;
    if (action !== "enable" && !window.confirm(t(action === "disable" ? "mobile_access_disable_confirm" : "mobile_access_regenerate_confirm"))) return;
    const request = ++revision.current;
    setBusy(true); setError(false);
    try {
      const response = await apiFetch(action === "disable" ? "/api/settings/mobile-access" : "/api/settings/mobile-access/regenerate", { method: action === "disable" ? "DELETE" : "POST" });
      if (!response.ok) throw new Error("Mobile access mutation failed");
      if (!active.current || request !== revision.current) return;
      if (action === "disable") {
        clearCopyFeedback(); setCopied(null); setShowToken(false); setQrSvg("");
        setInfo((current) => current ? { ...current, token: null } : current);
        onDisabled?.();
      } else await fetchInfo();
    } catch {
      if (active.current && request === revision.current) setError(true);
    } finally {
      if (active.current && request === revision.current) setBusy(false);
    }
  };

  const primary = info?.ips[0];
  const tailscale = info?.ips.find((ip) => ip.type === "tailscale");
  const fallbacks = info?.ips.filter((ip) => ip.type === "fallback") ?? [];
  const buildAccessUrl = (address: string) => `${info?.tlsEnabled ? "https" : "http"}://${address}:${info?.port}/#token=${encodeURIComponent(info?.token ?? "")}`;
  const primaryUrl = primary ? buildAccessUrl(primary.address) : "";

  return <>
    <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("mobile_access")}</div>
    {!info && busy && <p role="status" className="text-[calc(var(--ui-fs)-2px)] text-t3">{t("loading")}</p>}
    {error && <div role="alert" className="mb-3 text-[calc(var(--ui-fs)-2px)] text-danger">
      {t("request_failed")}
      {!info && <button type="button" className="ml-2 text-accent hover:text-accent-t" disabled={busy} onClick={() => void fetchInfo()}>{t("retry")}</button>}
    </div>}
    {info && (!info.token ? <div className="flex items-center justify-between gap-3 py-2">
      <span className="flex items-center gap-1.5 text-[calc(var(--ui-fs)-2px)] text-t2"><Icons.phone />{t("mobile_access")}</span>
      <button type="button" className="rounded bg-accent px-2.5 py-1 text-[calc(var(--ui-fs)-3px)] text-on-accent hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void mutate("enable")}>{t("mobile_access_enable")}</button>
    </div> : <>
      <div className="mb-4 flex flex-col items-center">
        <p className="mb-2 text-center text-[calc(var(--ui-fs)-2px)] text-t2">{t("mobile_access_scan_qr")}</p>
        <div className="rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      </div>
      {primaryUrl && <div className="mb-3 rounded bg-s2 px-3 py-2">
        <div className="mb-1 text-[calc(var(--ui-fs)-3px)] text-t3">{t("mobile_access_or_enter")}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-[calc(var(--ui-fs)-1px)] text-t1">{primaryUrl}</code>
          <button type="button" className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t" onClick={() => void copyToClipboard(primaryUrl, "url")}>{copied === "url" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
        </div>
      </div>}
      {tailscale && <div className="mb-3 rounded bg-s2 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[calc(var(--ui-fs)-3px)] text-accent-t"><Icons.Globe />{t("mobile_access_tailscale")}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-[calc(var(--ui-fs)-1px)] text-t1">{buildAccessUrl(tailscale.address)}</code>
          <button type="button" className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t" onClick={() => void copyToClipboard(buildAccessUrl(tailscale.address), "ts")}>{copied === "ts" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
        </div>
      </div>}
      <div className="mb-3 rounded bg-s2 px-3 py-2">
        <div className="mb-1 text-[calc(var(--ui-fs)-3px)] text-t3">{t("mobile_access_token")}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[calc(var(--ui-fs)-1px)] text-t1">{showToken ? info.token : "••••••••-••••-••••-••••-••••••••••••"}</code>
          <button type="button" aria-label={t("mobile_access_token")} aria-pressed={showToken} className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={() => setShowToken(!showToken)}><Icons.Eye /></button>
          <button type="button" className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t" onClick={() => void copyToClipboard(info.token!, "token")}>{copied === "token" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
        </div>
      </div>
      {fallbacks.length > 0 && <details className="mb-3">
        <summary className="cursor-pointer text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1">{t("mobile_access_alternate_ips")}</summary>
        <div className="mt-1 space-y-1">{fallbacks.map((ip) => <div key={ip.address} className="flex items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2">
          <code className="min-w-0 flex-1 break-all">{buildAccessUrl(ip.address)}</code>
          <button type="button" className="shrink-0 text-accent hover:text-accent-t" onClick={() => void copyToClipboard(buildAccessUrl(ip.address), ip.address)}>{copied === ip.address ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
        </div>)}</div>
      </details>}
      <p className="mb-3 text-[calc(var(--ui-fs)-2px)] text-t3">{t("mobile_access_firewall_warn", { port: info.port })}</p>
      <div className="flex flex-wrap items-center gap-2 border-t border-border2 pt-3">
        <button type="button" className="h-7 cursor-pointer rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:opacity-50" disabled={busy} onClick={() => void mutate("regenerate")}>{t("mobile_access_regenerate")}</button>
        <button type="button" className="h-7 cursor-pointer rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-danger-text transition-all hover:bg-danger-dim disabled:opacity-50" disabled={busy} onClick={() => void mutate("disable")}>{t("mobile_access_disable")}</button>
      </div>
    </>)}
  </>;
}

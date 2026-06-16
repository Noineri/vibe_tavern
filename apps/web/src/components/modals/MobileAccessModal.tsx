import { useState, useEffect, useCallback } from "react";
import { Modal } from "../shared/Modal.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import QRCode from "qrcode";

interface IPResult {
  address: string;
  type: "primary" | "tailscale" | "fallback";
  interfaceName: string;
}

interface MobileAccessInfo {
  ips: IPResult[];
  port: number;
  token: string | null;
  tlsEnabled: boolean;
}

interface MobileAccessModalProps {
  open: boolean;
  onClose: () => void;
  onDisabled: () => void;
}

export function MobileAccessModal({ open, onClose, onDisabled }: MobileAccessModalProps) {
  const { t } = useT();
  const [info, setInfo] = useState<MobileAccessInfo | null>(null);
  const [qrSvg, setQrSvg] = useState<string>("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const fetchInfo = useCallback(async () => {
    try {
      const resp = await fetch("/api/settings/mobile-access");
      if (resp.ok) {
        const data = await resp.json();
        setInfo(data);
        const primary = data.ips?.[0];
        if (primary && data.token) {
          const proto = data.tlsEnabled ? "https" : "http";
          const url = `${proto}://${primary.address}:${data.port}/#token=${encodeURIComponent(data.token)}`;
          const svg = await QRCode.toString(url, { type: "svg", width: 200, margin: 1 });
          setQrSvg(svg);
        } else {
          setQrSvg("");
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (open) fetchInfo(); }, [open, fetchInfo]);

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleRegenerate = async () => {
    if (!window.confirm(t("mobile_access_regenerate_confirm"))) return;
    await fetch("/api/settings/mobile-access/regenerate", { method: "POST" });
    await fetchInfo();
  };

  const handleDisable = async () => {
    if (!window.confirm(t("mobile_access_disable_confirm"))) return;
    await fetch("/api/settings/mobile-access", { method: "DELETE" });
    onDisabled();
    onClose();
  };

  if (!info || !info.token) return null;

  const primary = info.ips?.[0];
  const tailscale = info.ips?.find((ip: IPResult) => ip.type === "tailscale");
  const fallbacks = info.ips?.filter((ip: IPResult) => ip.type === "fallback") || [];
  const proto = info.tlsEnabled ? "https" : "http";
  const buildAccessUrl = (address: string) => `${proto}://${address}:${info.port}/#token=${encodeURIComponent(info.token!)}`;
  const primaryUrl = primary ? buildAccessUrl(primary.address) : "";

  return (
    <Modal open={open} onClose={onClose}>
      <div className="w-[360px] rounded-lg border border-border2 bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-ui text-[calc(var(--ui-fs)+1px)] font-semibold text-t1">{t("mobile_access")}</h2>
          <button type="button" onClick={onClose} className="text-t3 hover:text-t1"><Icons.Close /></button>
        </div>

        {/* QR Code */}
        <div className="flex flex-col items-center mb-4">
          <p className="mb-2 text-center text-[calc(var(--ui-fs)-2px)] text-t2">{t("mobile_access_scan_qr")}</p>
          <div className="rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        </div>

        {/* URL */}
        {primaryUrl && (
          <div className="mb-3 rounded bg-s2 px-3 py-2">
            <div className="mb-1 text-[calc(var(--ui-fs)-3px)] text-t3">{t("mobile_access_or_enter")}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-[calc(var(--ui-fs)-1px)] text-t1">{primaryUrl}</code>
              <button type="button"
                className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t"
                onClick={() => copyToClipboard(primaryUrl, "url")}
              >{copied === "url" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
            </div>
          </div>
        )}

        {/* Tailscale */}
        {tailscale && (
          <div className="mb-3 rounded bg-s2 px-3 py-2">
            <div className="mb-1 text-[calc(var(--ui-fs)-3px)] text-accent-t">🔗 {t("mobile_access_tailscale")}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-[calc(var(--ui-fs)-1px)] text-t1">{buildAccessUrl(tailscale.address)}</code>
              <button type="button"
                className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t"
                onClick={() => copyToClipboard(buildAccessUrl(tailscale.address), "ts")}
              >{copied === "ts" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
            </div>
          </div>
        )}

        {/* Token */}
        <div className="mb-3 rounded bg-s2 px-3 py-2">
          <div className="mb-1 text-[calc(var(--ui-fs)-3px)] text-t3">{t("mobile_access_token")}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate text-[calc(var(--ui-fs)-1px)] text-t1 font-mono">
              {showToken ? info.token : "••••••••-••••-••••-••••-••••••••••••"}
            </code>
            <button type="button" className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1" onClick={() => setShowToken(!showToken)}>
              <Icons.Eye />
            </button>
            <button type="button"
              className="shrink-0 text-[calc(var(--ui-fs)-2px)] text-accent hover:text-accent-t"
              onClick={() => copyToClipboard(info.token!, "token")}
            >{copied === "token" ? t("mobile_access_copied") : t("mobile_access_copy")}</button>
          </div>
        </div>

        {/* Fallback IPs */}
        {fallbacks.length > 0 && (
          <details className="mb-3">
            <summary className="cursor-pointer text-[calc(var(--ui-fs)-2px)] text-t3 hover:text-t1">{t("mobile_access_alternate_ips")}</summary>
            <div className="mt-1 space-y-1">
              {fallbacks.map((ip: IPResult) => (
                <div key={ip.address} className="flex items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2">
                  <code className="truncate">{buildAccessUrl(ip.address)}</code>
                  <button type="button" className="shrink-0 text-accent hover:text-accent-t" onClick={() => copyToClipboard(buildAccessUrl(ip.address), ip.address)}>
                    {copied === ip.address ? t("mobile_access_copied") : t("mobile_access_copy")}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Firewall warning */}
        <p className="mb-3 text-[calc(var(--ui-fs)-2px)] text-t3">
          {t("mobile_access_firewall_warn").replace("{port}", String(info.port))}
        </p>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t border-border2 pt-3">
          <button type="button"
            className="flex-1 rounded bg-s2 px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-t1 hover:bg-s3"
            onClick={handleRegenerate}
          >{t("mobile_access_regenerate")}</button>
          <button type="button"
            className="rounded px-3 py-1.5 text-[calc(var(--ui-fs)-2px)] text-danger-text hover:bg-danger-dim"
            onClick={handleDisable}
          >{t("mobile_access_disable")}</button>
        </div>
      </div>
    </Modal>
  );
}

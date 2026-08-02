import { useEffect, useState } from "react";
import type { ProxyRecord } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useModalStore } from "../../stores/modal-store.js";
import { MasterDetailModal, MasterDetailMobileDrillDown, useMasterDetail } from "../shared/MasterDetailModal.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { Icons } from "../shared/icons.js";
import { AddButton } from "../shared/add-button.js";
import { inputCls, lblCls } from "../build/fields/field-styles.js";

export interface ProxyDraft {
  id: string | null;
  name: string;
  url: string;
  username: string;
  password: string;
  hasStoredPassword: boolean;
  clearStoredPassword: boolean;
}

export function proxyToDraft(proxy: ProxyRecord): ProxyDraft {
  return {
    id: proxy.id,
    name: proxy.name,
    url: proxy.url,
    username: proxy.username ?? "",
    password: "",
    hasStoredPassword: proxy.hasStoredPassword,
    clearStoredPassword: false,
  };
}

export function emptyProxyDraft(): ProxyDraft {
  return { id: null, name: "", url: "", username: "", password: "", hasStoredPassword: false, clearStoredPassword: false };
}

/** Omitting password preserves a stored secret; null explicitly removes it. */
export function buildProxyWrite(draft: ProxyDraft) {
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    username: draft.username.length > 0 ? draft.username : null,
    password: draft.password.length > 0
      ? draft.password
      : (draft.clearStoredPassword ? null : undefined),
  };
}

interface ProxyManagerModalProps {
  proxies: ProxyRecord[];
  defaultProxyId: string | null;
  onCreate: (input: ReturnType<typeof buildProxyWrite>) => Promise<ProxyRecord>;
  onUpdate: (id: string, patch: ReturnType<typeof buildProxyWrite>) => Promise<ProxyRecord>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onProvidersChanged: () => Promise<void>;
}

function ProxyList({ proxies, editingId, defaultProxyId, onSelect, onAdd }: {
  proxies: ProxyRecord[];
  editingId: string | null;
  defaultProxyId: string | null;
  onSelect: (proxy: ProxyRecord) => void;
  onAdd: () => void;
}) {
  const { t } = useT();
  const { openDetail } = useMasterDetail();
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-5 pb-2.5">
      <div className="mb-1.5 px-4 font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3">{t("proxy_profiles_label")}</div>
      <div className="flex-1 overflow-y-auto">
        {proxies.map((proxy) => {
          const selected = proxy.id === editingId;
          return (
            <div
              key={proxy.id}
              className={cn("flex min-h-[56px] cursor-pointer items-center gap-3 border-l-[3px] pl-4 pr-2 touch-manipulation transition-colors", selected ? "border-l-accent bg-accent-dim text-accent-t" : "border-l-transparent text-t2 hover:bg-s2")}
              onPointerDown={() => onSelect(proxy)}
            >
              <span className={cn("h-2 w-2 shrink-0 rounded-full", selected ? "bg-accent" : "bg-t4")} />
              <div className="min-w-0 flex-1 py-2">
                <div className="truncate text-[13px] font-medium">{proxy.name}</div>
                <div className={cn("mt-0.5 truncate text-[11px]", selected ? "text-accent-t" : "text-t3")}>{proxy.id === defaultProxyId ? t("proxy_default_badge") : proxy.url}</div>
              </div>
              <MasterDetailMobileDrillDown onSelect={() => onSelect(proxy)} className="py-3" />
            </div>
          );
        })}
      </div>
      <AddButton className="mx-3 mt-3 h-auto justify-center py-2 font-medium" onClick={() => { onAdd(); openDetail(); }}>
        {t("proxy_new")}
      </AddButton>
    </div>
  );
}

export function ProxyManagerModal({ proxies, defaultProxyId, onCreate, onUpdate, onDelete, onRefresh, onProvidersChanged }: ProxyManagerModalProps) {
  const { t } = useT();
  const isOpen = useModalStore((state) => state.isProxyManagerOpen);
  const setIsOpen = useModalStore((state) => state.setIsProxyManagerOpen);
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDraft((current) => {
      if (current?.id === null) return current;
      const matching = current?.id ? proxies.find((proxy) => proxy.id === current.id) : undefined;
      return matching ? proxyToDraft(matching) : current ? null : (proxies[0] ? proxyToDraft(proxies[0]) : null);
    });
    setConfirmDelete(false);
    setConfirmClose(false);
  }, [isOpen, proxies]);

  const updateDraft = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setDirty(true);
    setError(null);
  };

  const toggleClearPassword = () => {
    setDraft((current) => current ? {
      ...current,
      password: "",
      clearStoredPassword: !current.clearStoredPassword,
    } : current);
    setDirty(true);
    setError(null);
  };

  const selectProxy = (proxy: ProxyRecord) => {
    setDraft(proxyToDraft(proxy));
    setDirty(false);
    setError(null);
  };
  const createProxy = () => {
    setDraft(emptyProxyDraft());
    setDirty(false);
    setError(null);
  };
  const close = () => {
    setDraft(null);
    setDirty(false);
    setError(null);
    setIsOpen(false);
  };
  const requestClose = () => dirty ? setConfirmClose(true) : close();

  const save = async () => {
    if (!draft || !dirty || saving || !draft.name.trim() || !draft.url.trim()) return;
    setSaving(true);
    try {
      const written = draft.id ? await onUpdate(draft.id, buildProxyWrite(draft)) : await onCreate(buildProxyWrite(draft));
      setDraft(proxyToDraft(written));
      setDirty(false);
      setError(null);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("request_failed"));
    } finally {
      setSaving(false);
    }
  };

  const deleteCurrent = async () => {
    if (!draft?.id) return;
    try {
      await onDelete(draft.id);
      setConfirmDelete(false);
      setDraft(null);
      setDirty(false);
      setError(null);
      await Promise.all([onRefresh(), onProvidersChanged()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("request_failed"));
    }
  };

  if (!isOpen) return null;
  return (
    <>
      {confirmClose && (
        <ConfirmCloseModal
          onConfirm={() => { setConfirmClose(false); close(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
      {confirmDelete && draft?.id && (
        <DestructiveConfirmModal
          title={t("proxy_delete_title")}
          body={t("proxy_delete_body", { name: draft.name })}
          confirmLabel={t("proxy_delete")}
          onConfirm={() => void deleteCurrent()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      <MasterDetailModal
        isOpen={true}
        onClose={requestClose}
        title={t("proxy_manager_title")}
        subtitle={t("proxy_manager_subtitle")}
        detailTitle={draft?.name || t("proxy_manager_title")}
        dirty={dirty}
        containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[600px] w-[760px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border"
        detailClassName="p-5"
        mobileDetailClassName="p-4"
        masterContent={() => <ProxyList proxies={proxies} editingId={draft?.id ?? null} defaultProxyId={defaultProxyId} onSelect={selectProxy} onAdd={createProxy} />}
        detailContent={draft ? (
          <div className="space-y-4">
            <div>
              <label className={lblCls}>{t("proxy_name")}</label>
              <input className={cn(inputCls, "mt-1.5")} value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder={t("proxy_name_placeholder")} />
            </div>
            <div>
              <label className={lblCls}>{t("proxy_url")}</label>
              <input className={cn(inputCls, "mt-1.5")} value={draft.url} onChange={(event) => updateDraft("url", event.target.value)} placeholder="http://proxy.example:8080" />
              <p className="mt-1 font-ui text-[11px] text-t3">{t("proxy_url_hint")}</p>
            </div>
            <div>
              <label className={lblCls}>{t("proxy_username")}</label>
              <input className={cn(inputCls, "mt-1.5")} value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} autoComplete="username" />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3">
                <label className={lblCls}>{t("proxy_password")}</label>
                {draft.hasStoredPassword && !draft.clearStoredPassword && <span className="font-ui text-[11px] text-t3">{t("proxy_password_stored")}</span>}
              </div>
              <input className={cn(inputCls, "mt-1.5 font-mono tracking-[0.05em]")} type="password" value={draft.password} onChange={(event) => { updateDraft("password", event.target.value); if (event.target.value) updateDraft("clearStoredPassword", false); }} autoComplete="new-password" placeholder={draft.hasStoredPassword && !draft.clearStoredPassword ? t("proxy_password_preserve") : undefined} />
              {draft.hasStoredPassword && (
                <button type="button" className="mt-2 font-ui text-[12px] text-danger/80 transition-colors hover:text-danger" onClick={toggleClearPassword}>
                  {draft.clearStoredPassword ? t("cancel") : t("proxy_password_clear")}
                </button>
              )}
              <p className="mt-1 font-ui text-[11px] text-t3">{draft.clearStoredPassword ? t("proxy_password_will_clear") : t("proxy_password_hint")}</p>
            </div>
            {error && <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">{error}</div>}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center font-ui text-[13px] text-t3">{t("proxy_select_or_create")}</div>
        )}
        footer={
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 py-3">
            {draft?.id && <button type="button" className="flex items-center gap-1.5 font-ui text-[13px] text-danger/80 transition-colors hover:text-danger" onClick={() => setConfirmDelete(true)}><Icons.Trash /> {t("proxy_delete")}</button>}
            <div className="ml-auto flex items-center gap-2">
              <button type="button" className="rounded-md border border-border px-4 py-2 font-ui text-[13px] text-t2 hover:bg-s2 hover:text-t1" onClick={requestClose}>{t("close")}</button>
              <button type="button" disabled={!dirty || !draft?.name.trim() || !draft.url.trim() || saving} className="rounded-md bg-accent px-4 py-2 font-ui text-[13px] font-medium text-on-accent disabled:opacity-40" onClick={() => void save()}>{saving ? t("saving") : t("save")}</button>
            </div>
          </div>
        }
      />
    </>
  );
}

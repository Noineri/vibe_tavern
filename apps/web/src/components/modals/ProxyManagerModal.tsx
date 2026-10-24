import { useEffect, useState } from "react";
import type { ProxyRecord } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useModalStore } from "../../stores/modal-store.js";
import { MasterDetailModal, useMasterDetail } from "../shared/MasterDetailModal.js";
import { MasterList } from "../shared/master-list/master-list.js";
import { SortableMasterListPhoneRow } from "../shared/master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../shared/master-list/master-list-overlay-row.js";
import { arrayMove } from "@dnd-kit/sortable";
import { reorderProxies } from "../../api/proxy-api.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { Icons } from "../shared/icons.js";
import { AddButton } from "../shared/add-button.js";
import { SAVED_DISPLAY_MS, SaveButton } from "../shared/SaveBar.js";
import { TextInput } from "../shared/text-input.js";
import { lblCls, listHeaderCls } from "../../lib/field-tokens.js";

type ProxySaveState = "idle" | "saving" | "saved";

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

// Row anatomy lives in `shared/master-list` (handle, status slot, wrapping
// title, overlay, phone drill-down row). This list supplies data + slots:
// the connection dot, the name + default-badge-or-URL second line, and the
// arrayMove + reorderProxies persist (the route stores the order; the
// refreshed parent list replaces the optimistic one on success, rollback
// otherwise — owned by the primitive's hook).
function ProxyList({ proxies, editingId, defaultProxyId, onSelect, onAdd, onRefresh }: {
  proxies: ProxyRecord[];
  editingId: string | null;
  defaultProxyId: string | null;
  onSelect: (proxy: ProxyRecord) => void;
  onAdd: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useT();
  const { openDetail } = useMasterDetail();
  const dot = (selected: boolean) => (
    <span className={cn("h-2 w-2 shrink-0 rounded-full", selected ? "bg-accent" : "bg-t4")} />
  );
  return (
    <MasterList<ProxyRecord>
      items={proxies}
      getId={(proxy) => proxy.id}
      onReorderItems={(activeId, overId, currentItems) => {
        const fromIdx = currentItems.findIndex((proxy) => proxy.id === activeId);
        const toIdx = currentItems.findIndex((proxy) => proxy.id === overId);
        if (fromIdx === -1 || toIdx === -1) {
          return { optimisticItems: currentItems, persist: () => {} };
        }
        const reordered = arrayMove(currentItems, fromIdx, toIdx);
        return {
          optimisticItems: reordered,
          persist: () => reorderProxies(reordered.map((proxy, i) => ({ id: proxy.id, sortOrder: i }))).then(() => onRefresh()),
        };
      }}
      header={<div className={cn(listHeaderCls, "mb-1.5 px-4")}>{t("proxy_profiles_label")}</div>}
      renderRow={(proxy) => (
        <SortableMasterListPhoneRow
          sortableId={proxy.id}
          rowTestId={`proxy-row-${proxy.id}`}
          selected={proxy.id === editingId}
          status={dot(proxy.id === editingId)}
          title={proxy.name}
          secondLine={proxy.id === defaultProxyId ? t("proxy_default_badge") : proxy.url}
          onSelect={() => onSelect(proxy)}
        />
      )}
      renderOverlayRow={(proxy) => (
        <MasterListDragOverlayRow status={dot(proxy.id === editingId)} title={proxy.name} />
      )}
      footer={
        <AddButton className="mx-3 mt-3 h-auto justify-center py-2 font-medium" onClick={() => { onAdd(); openDetail(); }}>
          {t("proxy_new")}
        </AddButton>
      }
    />
  );
}

export function ProxyManagerModal({ proxies, defaultProxyId, onCreate, onUpdate, onDelete, onRefresh, onProvidersChanged }: ProxyManagerModalProps) {
  const { t } = useT();
  const isOpen = useModalStore((state) => state.isProxyManagerOpen);
  const setIsOpen = useModalStore((state) => state.setIsProxyManagerOpen);
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveState, setSaveState] = useState<ProxySaveState>("idle");
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

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), SAVED_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const updateDraft = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setDirty(true);
    setSaveState("idle");
    setError(null);
  };

  const toggleClearPassword = () => {
    setDraft((current) => current ? {
      ...current,
      password: "",
      clearStoredPassword: !current.clearStoredPassword,
    } : current);
    setDirty(true);
    setSaveState("idle");
    setError(null);
  };

  const selectProxy = (proxy: ProxyRecord) => {
    setDraft(proxyToDraft(proxy));
    setDirty(false);
    setSaveState("idle");
    setError(null);
  };
  const createProxy = () => {
    setDraft(emptyProxyDraft());
    setDirty(false);
    setSaveState("idle");
    setError(null);
  };
  const close = () => {
    setDraft(null);
    setDirty(false);
    setSaveState("idle");
    setError(null);
    setIsOpen(false);
  };
  const requestClose = () => dirty ? setConfirmClose(true) : close();

  const save = async () => {
    if (!draft || !dirty || saveState === "saving" || !draft.name.trim() || !draft.url.trim()) return;
    setSaveState("saving");
    try {
      const written = draft.id ? await onUpdate(draft.id, buildProxyWrite(draft)) : await onCreate(buildProxyWrite(draft));
      setDraft(proxyToDraft(written));
      setDirty(false);
      setError(null);
      await onRefresh();
      setSaveState("saved");
    } catch (cause) {
      setSaveState("idle");
      setError(cause instanceof Error ? cause.message : t("request_failed"));
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
        containerClassName="max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[600px] w-[760px]"
        masterClassName="flex w-[220px] shrink-0 flex-col border-r border-border"
        detailClassName="p-5"
        mobileDetailClassName="p-4"
        masterContent={() => <ProxyList proxies={proxies} editingId={draft?.id ?? null} defaultProxyId={defaultProxyId} onSelect={selectProxy} onAdd={createProxy} onRefresh={onRefresh} />}
        detailContent={draft ? (
          <div className="space-y-4">
            <div>
              <label className={lblCls}>{t("proxy_name")}</label>
              <TextInput value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder={t("proxy_name_placeholder")} />
            </div>
            <div>
              <label className={lblCls}>{t("proxy_url")}</label>
              <TextInput value={draft.url} onChange={(event) => updateDraft("url", event.target.value)} placeholder="http://proxy.example:8080" />
              <p className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("proxy_url_hint")}</p>
            </div>
            <div>
              <label className={lblCls}>{t("proxy_username")}</label>
              <TextInput value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} autoComplete="username" />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3">
                <label className={lblCls}>{t("proxy_password")}</label>
                {draft.hasStoredPassword && !draft.clearStoredPassword && <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("proxy_password_stored")}</span>}
              </div>
              <TextInput mono type="password" value={draft.password} onChange={(event) => { updateDraft("password", event.target.value); if (event.target.value) updateDraft("clearStoredPassword", false); }} autoComplete="new-password" placeholder={draft.hasStoredPassword && !draft.clearStoredPassword ? t("proxy_password_preserve") : undefined} />
              {draft.hasStoredPassword && (
                <button type="button" className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] text-danger/80 transition-colors hover:text-danger" onClick={toggleClearPassword}>
                  {draft.clearStoredPassword ? t("cancel") : t("proxy_password_clear")}
                </button>
              )}
              <p className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{draft.clearStoredPassword ? t("proxy_password_will_clear") : t("proxy_password_hint")}</p>
            </div>
            {error && <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{error}</div>}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center font-ui text-[calc(var(--ui-fs)-1px)] text-t3">{t("proxy_select_or_create")}</div>
        )}
        footer={
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 pt-3 pb-3 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
            {draft?.id && <button type="button" className="flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-1px)] text-danger/80 transition-colors hover:text-danger" onClick={() => setConfirmDelete(true)}><Icons.Trash /> {t("proxy_delete")}</button>}
            <div className="ml-auto flex items-center gap-2">
              <button type="button" className="rounded-md border border-border px-4 py-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t2 hover:bg-s2 hover:text-t1" onClick={requestClose}>{t("close")}</button>
              <SaveButton
                dirty={dirty}
                saveState={saveState}
                resetKey={draft?.id}
                disabled={!draft?.name.trim() || !draft.url.trim()}
                label={t("save")}
                onClick={() => void save()}
              />
            </div>
          </div>
        }
      />
    </>
  );
}

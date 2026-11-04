import { useEffect, useId, useRef, useState } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import type { ProxyRecord } from "../../api/types.js";
import { reorderProxies } from "../../api/proxy-api.js";
import { useT } from "../../i18n/context.js";
import { lblCls } from "../../lib/field-tokens.js";
import { MasterDetailFooter } from "../shared/MasterDetailModal.js";
import { MasterList } from "../shared/master-list/master-list.js";
import { SortableMasterListRow } from "../shared/master-list/master-list-row.js";
import { MasterListDragOverlayRow } from "../shared/master-list/master-list-overlay-row.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { ConfirmCloseModal } from "../shared/confirm-close-modal.js";
import { Icons } from "../shared/icons.js";
import { AddButton } from "../shared/add-button.js";
import { SAVED_DISPLAY_MS, SaveButton } from "../shared/SaveBar.js";
import { TextInput } from "../shared/text-input.js";
import { buildProxyWrite, emptyProxyDraft, proxyToDraft, type ProxyDraft } from "./proxy-draft.js";
import { SettingsSectionFooter, useSettingsSectionClose, useSettingsSectionDirty, useSettingsSectionLeaveGuard } from "./settings-section-lifecycle.js";

export interface ProxySettingsSectionProps {
  proxies: ProxyRecord[];
  defaultProxyId: string | null;
  onCreate: (input: ReturnType<typeof buildProxyWrite>) => Promise<ProxyRecord>;
  onUpdate: (id: string, patch: ReturnType<typeof buildProxyWrite>) => Promise<ProxyRecord>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onProvidersChanged: () => Promise<void>;
}

/** Moved from ProxyManagerModal; the decided list/editor swap replaces its nested split. */
export function ProxySettingsSection({ proxies, defaultProxyId, onCreate, onUpdate, onDelete, onRefresh, onProvidersChanged }: ProxySettingsSectionProps) {
  const { t } = useT();
  const fieldId = useId();
  const close = useSettingsSectionClose();
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const leave = useRef<(() => void) | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestLeave = (next: () => void) => {
    if (dirty) { leave.current = next; setConfirmClose(true); }
    else next();
  };
  useSettingsSectionLeaveGuard(requestLeave);
  useSettingsSectionDirty(dirty);
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), SAVED_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const edit = (value: ProxyDraft | null) => { setDraft(value); setDirty(false); setSaveState("idle"); setError(null); };
  const updateDraft = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setDirty(true); setSaveState("idle"); setError(null);
  };
  const toggleClearPassword = () => {
    setDraft((current) => current ? { ...current, password: "", clearStoredPassword: !current.clearStoredPassword } : current);
    setDirty(true); setSaveState("idle"); setError(null);
  };
  const save = async () => {
    if (!draft || !dirty || saveState === "saving" || !draft.name.trim() || !draft.url.trim()) return;
    setSaveState("saving");
    try {
      const written = draft.id ? await onUpdate(draft.id, buildProxyWrite(draft)) : await onCreate(buildProxyWrite(draft));
      setDraft(proxyToDraft(written)); setDirty(false); setError(null);
      await onRefresh(); setSaveState("saved");
    } catch (cause) { setSaveState("idle"); setError(cause instanceof Error ? cause.message : t("request_failed")); }
  };
  const deleteCurrent = async () => {
    if (!draft?.id) return;
    try {
      await onDelete(draft.id);
      setConfirmDelete(false); edit(null);
      await Promise.all([onRefresh(), onProvidersChanged()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("request_failed")); }
  };

  return <>
    <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("proxies")}</div>
    <p className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("proxy_manager_subtitle")}</p>
    {draft ? <>
      <button type="button" className="mb-4 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => requestLeave(() => edit(null))}><Icons.Caret direction="l" />{t("proxies")}</button>
      <div className="space-y-4">
        <div>
          <label className={lblCls} htmlFor={`${fieldId}-name`}>{t("proxy_name")}</label>
          <TextInput id={`${fieldId}-name`} value={draft.name} disabled={saveState === "saving"} onChange={(event) => updateDraft("name", event.target.value)} placeholder={t("proxy_name_placeholder")} />
        </div>
        <div>
          <label className={lblCls} htmlFor={`${fieldId}-url`}>{t("proxy_url")}</label>
          <TextInput id={`${fieldId}-url`} value={draft.url} disabled={saveState === "saving"} onChange={(event) => updateDraft("url", event.target.value)} placeholder="http://proxy.example:8080" />
          <p className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("proxy_url_hint")}</p>
        </div>
        <div>
          <label className={lblCls} htmlFor={`${fieldId}-username`}>{t("proxy_username")}</label>
          <TextInput id={`${fieldId}-username`} value={draft.username} disabled={saveState === "saving"} onChange={(event) => updateDraft("username", event.target.value)} autoComplete="username" />
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <label className={lblCls} htmlFor={`${fieldId}-password`}>{t("proxy_password")}</label>
            {draft.hasStoredPassword && !draft.clearStoredPassword && <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("proxy_password_stored")}</span>}
          </div>
          <TextInput mono id={`${fieldId}-password`} type="password" value={draft.password} disabled={saveState === "saving"} onChange={(event) => { updateDraft("password", event.target.value); if (event.target.value) updateDraft("clearStoredPassword", false); }} autoComplete="new-password" placeholder={draft.hasStoredPassword && !draft.clearStoredPassword ? t("proxy_password_preserve") : undefined} />
          {draft.hasStoredPassword && <button type="button" disabled={saveState === "saving"} className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] text-danger/80 transition-colors hover:text-danger" onClick={toggleClearPassword}>{draft.clearStoredPassword ? t("cancel") : t("proxy_password_clear")}</button>}
          <p className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{draft.clearStoredPassword ? t("proxy_password_will_clear") : t("proxy_password_hint")}</p>
        </div>
      </div>
      <SettingsSectionFooter>
        <MasterDetailFooter
          actions={draft.id ? [{ icon: <Icons.Trash />, label: t("proxy_delete"), destructive: true, disabled: saveState === "saving", onClick: () => setConfirmDelete(true) }] : []}
          right={<>
            <button type="button" className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={close}>{t("close")}</button>
            <SaveButton dirty={dirty} saveState={saveState} disabled={!draft.name.trim() || !draft.url.trim()} label={t("save")} onClick={() => void save()} />
          </>}
        />
      </SettingsSectionFooter>
    </> : <MasterList<ProxyRecord>
      items={proxies} getId={(proxy) => proxy.id}
      onReorderItems={(activeId, overId, items) => {
        const from = items.findIndex((proxy) => proxy.id === activeId);
        const to = items.findIndex((proxy) => proxy.id === overId);
        if (from === -1 || to === -1) return { optimisticItems: items, persist: () => {} };
        const reordered = arrayMove(items, from, to);
        return { optimisticItems: reordered, persist: () => reorderProxies(reordered.map((proxy, sortOrder) => ({ id: proxy.id, sortOrder }))).then(() => onRefresh()) };
      }}
      renderRow={(proxy) => <SortableMasterListRow sortableId={proxy.id} rowTestId={`proxy-row-${proxy.id}`} title={proxy.name}
        secondLine={<span className="break-all">{proxy.url}</span>}
        tags={proxy.id === defaultProxyId ? <span>{t("proxy_default_badge")}</span> : undefined}
        onSelect={() => edit(proxyToDraft(proxy))}
        trailing={<button type="button" aria-label={proxy.name} className="shrink-0 px-2 py-3 text-t3 transition-colors hover:text-t1" onClick={() => edit(proxyToDraft(proxy))}><Icons.Caret direction="r" /></button>}
      />}
      renderOverlayRow={(proxy) => <MasterListDragOverlayRow title={proxy.name} />}
      footer={<AddButton className="mx-3 mt-3 h-auto justify-center py-2 font-medium" onClick={() => edit(emptyProxyDraft())}>{t("proxy_new")}</AddButton>}
    />}
    {error && <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{error}</div>}
    {confirmClose && <ConfirmCloseModal onConfirm={() => { const next = leave.current; leave.current = null; setConfirmClose(false); next?.(); }} onCancel={() => { leave.current = null; setConfirmClose(false); }} />}
    {confirmDelete && draft?.id && <DestructiveConfirmModal title={t("proxy_delete_title")} body={t("proxy_delete_body", { name: draft.name })} confirmLabel={t("proxy_delete")} onConfirm={() => void deleteCurrent()} onCancel={() => setConfirmDelete(false)} />}
  </>;
}

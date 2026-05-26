import { useRef, useState } from 'react';
import { Ic } from './shared/icons';
import { cn } from '../lib/cn';
import { useT } from '../i18n/context.js';
import { useCharacterController } from '../hooks/use-character-controller.js';
import { useBootstrapStore } from '../stores/api-actions/bootstrap-actions.js';
import { useIsMobile } from '../hooks/use-mobile.js';

interface WelcomeScreenProps {
  onCreateCharacter: (input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }) => Promise<void>;
  onImportFiles: (files: FileList | File[]) => void;
  onFreeChat: () => Promise<void>;
}

export function WelcomeScreen() {
  const { t } = useT();
  const character = useCharacterController();
  const bootstrapData = useBootstrapStore((s) => s.data);
  const isMobile = useIsMobile();
  const isFirstRun = (bootstrapData?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === 'true';
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [firstMsg, setFirstMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const canCreate = name.trim().length > 0 && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await character.handleCreateCharacter({
        name: name.trim(),
        description: desc.trim() || undefined,
        firstMessage: firstMsg.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleFreeChat = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await character.handleFreeChat();
    } finally {
      setBusy(false);
    }
  };

  const cardBase = "flex flex-col items-center gap-1.5 rounded-[10px] border border-border2 bg-s2 px-4 py-5 text-center text-t1 transition-all hover:border-accent hover:bg-surface cursor-pointer";

  if (!isFirstRun) return null;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] w-[540px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}>
        <div className={cn("text-center", isMobile ? "px-4 pt-5" : "px-7 pt-7")}>
          <div className="mb-1.5 font-ui text-[1.35rem] font-bold text-t1">{t("ws_title")}</div>
          <div className="mb-6 font-ui text-[0.88rem] text-t2">{t("ws_sub")}</div>
        </div>

        {!creating ? (
          <div className={cn("flex flex-col gap-3", isMobile ? "px-4 pb-5" : "px-7 pb-7")}>
            <button className={cardBase} onClick={() => setCreating(true)}>
              <div className="text-[1.4rem] text-accent">{Ic.edit()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_create")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_create_sub")}</div>
            </button>

            <button className={cardBase} onClick={() => fileRef.current?.click()}>
              <div className="text-[1.4rem] text-accent">{Ic.import()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_import")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_import_sub")}</div>
            </button>

            <button className={cn(cardBase, "opacity-70 hover:opacity-100")} onClick={handleFreeChat} disabled={busy}>
              <div className="text-[1.4rem] text-accent">{Ic.plus()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_free")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_free_sub")}</div>
            </button>
          </div>
        ) : (
          <div className={cn("flex flex-col gap-3.5", isMobile ? "px-4 pb-5" : "px-7 pb-7")}>
            <label className="flex flex-col gap-1">
              <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_name_label")}</span>
              <input
                className={cn("w-full rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base min-h-[44px]" : "text-[0.9rem]")}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("ws_name_placeholder")}
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_desc_label")}</span>
              <textarea
                className={cn("w-full min-h-[60px] resize-y rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base" : "text-[0.9rem]")}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_first_msg_label")}</span>
              <textarea
                className={cn("w-full min-h-[60px] resize-y rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base" : "text-[0.9rem]")}
                value={firstMsg}
                onChange={(e) => setFirstMsg(e.target.value)}
                rows={3}
              />
            </label>
            <div className="mt-1 flex items-center justify-between">
              <button className="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2.5 font-ui text-[0.9rem] font-semibold text-t2 transition-all hover:text-t1" onClick={() => setCreating(false)} disabled={busy}>{t("back")}</button>
              <button className="cursor-pointer rounded-lg border-0 bg-accent px-[22px] py-2.5 font-ui text-[0.9rem] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40" disabled={!canCreate} onClick={handleCreate}>
                {busy ? t("ws_creating") : t("ws_create_btn")}
              </button>
            </div>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".png,.json"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              character.handleImportFiles(e.target.files);
            }
          }}
        />
      </div>
    </div>
  );
}

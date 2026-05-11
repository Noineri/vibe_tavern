import { useRef, useState } from 'react';
import { Ic } from './shared/icons';
import { cn } from '../lib/cn';
import { useT } from '../i18n/context.js';
import { useAppActions } from './AppShell.js';
import { useCharacterStore } from '../stores/character-store.js';

interface WelcomeScreenProps {
  onCreateCharacter: (input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }) => Promise<void>;
  onImportFiles: (files: FileList | File[]) => void;
  onFreeChat: () => Promise<void>;
}

export function WelcomeScreen() {
  const { t } = useT();
  const actions = useAppActions();
  const isFirstRun = useCharacterStore((s) => s.isFirstRun);
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
      await actions.handleCreateCharacter({
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
      await actions.handleFreeChat();
    } finally {
      setBusy(false);
    }
  };

  const cardBase = "flex flex-col items-center gap-1.5 rounded-[10px] border border-border2 bg-s2 text-center text-t1 transition-all hover:border-accent hover:bg-surface";

  if (!isFirstRun) return null;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div className="flex max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]" style={{width:540}}>
        <div className="text-center" style={{padding:'28px 28px 0'}}>
          <div className="font-ui text-[1.35rem] font-bold text-t1" style={{marginBottom:6}}>{t("ws_title")}</div>
          <div className="font-ui text-[0.88rem] text-t2" style={{marginBottom:24}}>{t("ws_sub")}</div>
        </div>

        {!creating ? (
          <div className="flex flex-col gap-3" style={{padding:'0 28px 28px'}}>
            <button className={cardBase} style={{padding:'20px 16px', cursor:'pointer'}} onClick={() => setCreating(true)}>
              <div className="text-[1.4rem] text-accent">{Ic.edit()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_create")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_create_sub")}</div>
            </button>

            <button className={cardBase} style={{padding:'20px 16px', cursor:'pointer'}} onClick={() => fileRef.current?.click()}>
              <div className="text-[1.4rem] text-accent">{Ic.import()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_import")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_import_sub")}</div>
            </button>

            <button className={cn(cardBase, "opacity-70 hover:opacity-100")} style={{padding:'20px 16px', cursor:'pointer'}} onClick={handleFreeChat} disabled={busy}>
              <div className="text-[1.4rem] text-accent">{Ic.plus()}</div>
              <div className="font-ui text-[0.95rem] font-semibold">{t("ws_free")}</div>
              <div className="font-ui text-[0.8rem] text-t2">{t("ws_free_sub")}</div>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5" style={{padding:'0 28px 28px'}}>
            <label className="flex flex-col gap-1">
              <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_name_label")}</span>
              <input
                className="w-full rounded-lg border border-border2 bg-s2 font-ui text-[0.9rem] text-t1 outline-none transition-colors focus:border-accent"
                style={{padding:'10px 12px'}}
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
                className="w-full resize-y rounded-lg border border-border2 bg-s2 font-ui text-[0.9rem] text-t1 outline-none transition-colors focus:border-accent"
                style={{padding:'10px 12px', minHeight:60}}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_first_msg_label")}</span>
              <textarea
                className="w-full resize-y rounded-lg border border-border2 bg-s2 font-ui text-[0.9rem] text-t1 outline-none transition-colors focus:border-accent"
                style={{padding:'10px 12px', minHeight:60}}
                value={firstMsg}
                onChange={(e) => setFirstMsg(e.target.value)}
                rows={3}
              />
            </label>
            <div className="mt-1 flex items-center justify-between">
              <button className="cursor-pointer rounded-lg border-0 bg-transparent font-ui text-[0.9rem] font-semibold text-t2 transition-all hover:text-t1" style={{padding:'10px 12px'}} onClick={() => setCreating(false)} disabled={busy}>{t("back")}</button>
              <button className="cursor-pointer rounded-lg border-0 bg-accent font-ui text-[0.9rem] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40" style={{padding:'10px 22px'}} disabled={!canCreate} onClick={handleCreate}>
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
              actions.handleImportFiles(e.target.files);
            }
          }}
        />
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';

interface WelcomeScreenProps {
  onCreateCharacter: (input: { name: string; description?: string; firstMessage?: string }) => Promise<void>;
  onImportFiles: (files: FileList | File[]) => void;
  onFreeChat: () => Promise<void>;
}

export function WelcomeScreen({ onCreateCharacter, onImportFiles, onFreeChat }: WelcomeScreenProps) {
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
      await onCreateCharacter({
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
      await onFreeChat();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="api-overlay">
      <div className="api-modal ws-modal">
        <div className="ws-head">
          <div className="ws-title">Добро пожаловать</div>
          <div className="ws-sub">Выберите, как начать</div>
        </div>

        {!creating ? (
          <div className="ws-cards">
            <button className="ws-card" onClick={() => setCreating(true)}>
              <div className="ws-card-icon">✦</div>
              <div className="ws-card-title">Создать персонажа</div>
              <div className="ws-card-sub">Заполните имя, описание и первое сообщение</div>
            </button>

            <button className="ws-card" onClick={() => fileRef.current?.click()}>
              <div className="ws-card-icon">↑</div>
              <div className="ws-card-title">Загрузить карточку</div>
              <div className="ws-card-sub">Загрузите PNG или JSON карточку персонажа</div>
            </button>

            <button className="ws-card ws-card--muted" onClick={handleFreeChat} disabled={busy}>
              <div className="ws-card-icon">💬</div>
              <div className="ws-card-title">Продолжить без персонажа</div>
              <div className="ws-card-sub">Начните свободный чат прямо сейчас</div>
            </button>
          </div>
        ) : (
          <div className="ws-form">
            <label className="ws-field">
              <span className="ws-field-label">Имя *</span>
              <input
                className="ws-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя персонажа"
                autoFocus
              />
            </label>
            <label className="ws-field">
              <span className="ws-field-label">Описание</span>
              <textarea
                className="ws-textarea"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
              />
            </label>
            <label className="ws-field">
              <span className="ws-field-label">Первое сообщение</span>
              <textarea
                className="ws-textarea"
                value={firstMsg}
                onChange={(e) => setFirstMsg(e.target.value)}
                rows={3}
              />
            </label>
            <div className="ws-form-actions">
              <button className="ws-btn ws-btn--ghost" onClick={() => setCreating(false)} disabled={busy}>← Назад</button>
              <button className="ws-btn ws-btn--primary" disabled={!canCreate} onClick={handleCreate}>
                {busy ? 'Создание…' : 'Создать'}
              </button>
            </div>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".png,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onImportFiles(e.target.files);
            }
          }}
        />
      </div>
    </div>
  );
}

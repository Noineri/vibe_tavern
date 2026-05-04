import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { Icons } from "./shared/icons.js";
import { EmptyState } from "./shared/empty-state.js";
import { DestructiveConfirmModal } from "./shared/destructive-confirm-modal.js";

interface PersonaListItem {
  id: string;
  name: string;
  description: string;
}

interface PersonaModalProps {
  isOpen: boolean;
  personas: PersonaListItem[];
  activePersonaId: string | null;
  isSaving: boolean;
  onClose: () => void;
  onSaveEdit: (personaId: string, draft: { name: string; description: string }) => void;
  onSetActive: (personaId: string) => void;
  onCreatePersona: (input: { name: string; description: string }) => Promise<{ id: string } | null>;
  onDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
  onGetPersonalLorebookStatus: (personaId: string) => Promise<{ enabled: boolean; lorebookId: string | null }>;
  onSetPersonalLorebookEnabled: (personaId: string, enabled: boolean) => Promise<{ enabled: boolean; lorebookId: string | null } | null>;
}

export function PersonaModal(input: PersonaModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string>("");
  const [personalLorebookEnabled, setPersonalLorebookEnabled] = useState<boolean>(false);
  const [personalLorebookLoading, setPersonalLorebookLoading] = useState<boolean>(false);

  useEffect(() => {
    if (input.isOpen) {
      setSelectedId(input.activePersonaId);
      setEditingId(null);
    }
  }, [input.isOpen, input.activePersonaId]);

  useEffect(() => {
    let cancelled = false;
    if (input.isOpen && selectedId) {
      input.onGetPersonalLorebookStatus(selectedId).then((status) => {
        if (!cancelled) setPersonalLorebookEnabled(status.enabled);
      }).catch(() => { /* ignore */ });
    }
    return () => { cancelled = true; };
  }, [input.isOpen, selectedId]);

  if (!input.isOpen) return null;

  const selectedPersona = input.personas.find((p) => p.id === selectedId) || input.personas[0] || null;
  const isEditing = editingId !== null;
  const isLastPersona = input.personas.length <= 1;

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    setEditName(persona.name);
    setEditDescription(persona.description);
  }

  function commitEdit(): void {
    if (!editingId || !editName.trim()) return;
    input.onSaveEdit(editingId, { name: editName.trim(), description: editDescription });
    setSelectedId(editingId);
    setEditingId(null);
  }

  function cancelEdit(): void {
    setEditingId(null);
  }

  function setActiveAndClose(): void {
    if (selectedPersona) input.onSetActive(selectedPersona.id);
    input.onClose();
  }

  return (
    <div className="api-overlay" onClick={input.onClose}>
      {confirmDeleteId && (
        <DestructiveConfirmModal
          title="Delete persona?"
          body={
            <>
              Are you sure? Persona <b>{input.personas.find((p) => p.id === confirmDeleteId)?.name ?? "Untitled"}</b> will be deleted permanently.
              {deleteError && <div style={{ marginTop: 8, color: "oklch(0.6 0.15 25)" }}>{deleteError}</div>}
            </>
          }
          confirmLabel="Delete"
          onConfirm={async () => {
            const id = confirmDeleteId;
            if (!id) return;
            const result = await input.onDeletePersona(id);
            if (result.ok) {
              setConfirmDeleteId(null);
              setDeleteError("");
              if (selectedId === id) setSelectedId(null);
            } else {
              setDeleteError(result.error ?? "Delete failed.");
            }
          }}
          onCancel={() => {
            setConfirmDeleteId(null);
            setDeleteError("");
          }}
        />
      )}
      <div
        className="api-modal"
        style={{ maxWidth: 480 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="api-head" style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div className="api-title">Persona Manager</div>
              <div className="api-sub">Whose voice are you using in chat?</div>
            </div>
            <button
              className="iBtn"
              aria-label="Close persona manager"
              title="Close persona manager"
              onClick={input.onClose}
            >
              <Icons.Close />
            </button>
          </div>
        </div>
        <div className="api-body">
          <div className="persona-list">
            {input.personas.length === 0 && (
              <EmptyState
                icon={<Icons.User />}
                title="No personas"
                sub="Create one to get started."
              />
            )}
            {input.personas.map((persona) => {
              const isSelected = selectedId === persona.id;
              const editingThis = editingId === persona.id;
              return (
                <div
                  key={persona.id}
                  className={`persona-card${isSelected ? " act" : ""}`}
                  onClick={() => !isEditing && setSelectedId(persona.id)}
                >
                  {editingThis ? (
                    <div style={{ width: "100%" }} onClick={(event) => event.stopPropagation()}>
                      <input
                        className="persona-edit-field"
                        value={editName}
                        placeholder="Name"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setEditName(event.target.value)}
                      />
                      <textarea
                        className="persona-edit-field"
                        value={editDescription}
                        placeholder="Description"
                        style={{ minHeight: 60, resize: "vertical" }}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setEditDescription(event.target.value)}
                      />
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button
                          className="api-cancel-btn"
                          style={{ height: 26, padding: "0 10px" }}
                          onClick={cancelEdit}
                        >
                          Cancel
                        </button>
                        <button
                          className="api-save-btn"
                          style={{ height: 26, padding: "0 10px" }}
                          disabled={input.isSaving || !editName.trim()}
                          onClick={commitEdit}
                        >
                          {input.isSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="persona-ava">{persona.name.slice(0, 1).toUpperCase()}</div>
                      <div className="persona-info">
                        <div className="persona-name">{persona.name}</div>
                        <div className="persona-desc">{persona.description}</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div
                            className="persona-edit-btn"
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              startEdit(persona);
                            }}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); startEdit(persona); } }}
                          >
                            <Icons.Edit /> Edit
                          </div>
                          <div
                            className="persona-edit-btn"
                            role="button"
                            tabIndex={0}
                            style={{ opacity: 0.45, cursor: "not-allowed" }}
                            title="Duplicate not yet implemented"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Icons.Copy /> Duplicate
                          </div>
                          <div
                            className="persona-edit-btn"
                            role="button"
                            tabIndex={0}
                            style={{ color: "oklch(0.6 0.15 25)", cursor: isLastPersona ? "not-allowed" : "pointer", opacity: isLastPersona ? 0.6 : 1 }}
                            title={isLastPersona ? "You cannot delete the last persona." : "Delete persona"}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (isLastPersona) {
                                setDeleteError("You cannot delete the last persona.");
                                return;
                              }
                              setConfirmDeleteId(persona.id);
                              setDeleteError("");
                            }}
                          >
                            <Icons.Trash /> Delete
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            <button
              className="add-btn-row"
              onClick={async () => {
                const created = await input.onCreatePersona({ name: "New persona", description: "" });
                if (created) {
                  setSelectedId(created.id);
                  setEditingId(created.id);
                  setEditName("New persona");
                  setEditDescription("");
                }
              }}
              style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--t1)", textAlign: "left", display: "flex", alignItems: "center" }}
            >
              <Icons.Plus /> <span style={{ marginLeft: 6 }}>Create new persona</span>
            </button>
            {deleteError && !confirmDeleteId && (
              <div className="api-hint" style={{ marginTop: 8, color: "oklch(0.6 0.15 25)" }}>{deleteError}</div>
            )}
          </div>

          <div className="api-section-title" style={{ marginTop: 24 }}>Persona settings</div>
          <div className="api-field">
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--t1)", textTransform: "none", letterSpacing: 0, fontSize: 13, fontWeight: 400, cursor: selectedPersona && !personalLorebookLoading ? "pointer" : "not-allowed", opacity: selectedPersona ? 1 : 0.6 }}
              title={selectedPersona ? "Toggle personal lorebook for this persona" : "Select a persona first"}
            >
              <span className="toggle">
                <input
                  type="checkbox"
                  checked={personalLorebookEnabled}
                  disabled={!selectedPersona || personalLorebookLoading}
                  onChange={async () => {
                    if (!selectedPersona) return;
                    const next = !personalLorebookEnabled;
                    setPersonalLorebookLoading(true);
                    const result = await input.onSetPersonalLorebookEnabled(selectedPersona.id, next);
                    setPersonalLorebookLoading(false);
                    if (result) setPersonalLorebookEnabled(result.enabled);
                  }}
                />
                <span className="tgl-sl" />
              </span>
              Personal Lorebook (per-persona RAG)
            </label>
            <div className="api-hint" style={{ marginTop: 8 }}>
              When enabled, facts and worldbuilding tied to this persona will be injected into context via RAG.
            </div>
          </div>
        </div>
        <div className="api-foot">
          <button className="api-cancel-btn" onClick={input.onClose} style={{ marginLeft: "auto" }}>
            Close
          </button>
          <button
            className="api-save-btn"
            disabled={!selectedPersona || isEditing}
            onClick={setActiveAndClose}
          >
            Set as active
          </button>
        </div>
      </div>
    </div>
  );
}

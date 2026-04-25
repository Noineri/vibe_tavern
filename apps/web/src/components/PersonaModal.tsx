import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { Icons } from "./shared/icons.js";
import { EmptyState } from "./shared/empty-state.js";

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
}

export function PersonaModal(input: PersonaModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(input.activePersonaId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  useEffect(() => {
    if (input.isOpen) {
      setSelectedId(input.activePersonaId);
      setEditingId(null);
    }
  }, [input.isOpen, input.activePersonaId]);

  if (!input.isOpen) return null;

  const selectedPersona = input.personas.find((p) => p.id === selectedId) || input.personas[0] || null;
  const isEditing = editingId !== null;

  function startEdit(persona: PersonaListItem): void {
    setEditingId(persona.id);
    setEditName(persona.name);
    setEditDescription(persona.description);
  }

  function commitEdit(): void {
    if (!editingId || !editName.trim()) return;
    input.onSaveEdit(editingId, { name: editName.trim(), description: editDescription });
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
              className="icon-btn"
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
                sub="Persona creation is not yet wired to the backend."
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
                            onClick={(event) => {
                              event.stopPropagation();
                              startEdit(persona);
                            }}
                          >
                            <Icons.Edit /> Edit
                          </div>
                          <div
                            className="persona-edit-btn"
                            style={{ opacity: 0.45, cursor: "not-allowed" }}
                            title="Backend pending — see BACKEND_BACKLOG B-persona-lifecycle"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Icons.Copy /> Duplicate
                          </div>
                          <div
                            className="persona-edit-btn"
                            style={{ opacity: 0.45, cursor: "not-allowed", color: "oklch(0.6 0.15 25)" }}
                            title="Backend pending — see BACKEND_BACKLOG B-persona-lifecycle"
                            onClick={(event) => event.stopPropagation()}
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
            <div
              className="add-btn-row"
              style={{ opacity: 0.45, cursor: "not-allowed" }}
              title="Backend pending — see BACKEND_BACKLOG B-persona-lifecycle"
            >
              <Icons.Plus /> <span style={{ marginLeft: 6 }}>Create new persona</span>
            </div>
          </div>

          <div className="api-section-title" style={{ marginTop: 24 }}>Persona settings</div>
          <div className="api-field">
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--t1)", textTransform: "none", letterSpacing: 0, fontSize: 13, fontWeight: 400, cursor: "not-allowed", opacity: 0.6 }}
              title="Backend pending — see BACKEND_BACKLOG B-persona-lifecycle"
            >
              <span className="toggle">
                <input type="checkbox" disabled />
                <span className="tgl-sl" />
              </span>
              Personal Lorebook (per-persona RAG)
            </label>
            <div className="api-hint" style={{ marginTop: 8 }}>
              When enabled, facts and worldbuilding tied to this persona will be injected into context via RAG. Backend pending.
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

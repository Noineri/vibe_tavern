/**
 * STT quickstart recipes (STT_PLAN ST-4a) — a minimal fork of the TTS preset
 * mechanism. These are RECIPES (owner rule 2026-09-01: quickstart cards are
 * not "hardcoded model catalogs" — no list-endpoint exists for STT models
 * yet, and the recipe shape is the same prescriptive form the TTS local
 * server quickstarts use). Applying one fills the config fields of an
 * OpenAI-compatible profile (endpoint + model); the user stays free to edit
 * both afterwards.
 */

export interface SttQuickstart {
  id: string;
  label: string;
  /** Endpoint the config will carry for this vendor. */
  endpoint: string;
  /** Model the config will carry for this vendor. */
  model: string;
}

/** Direct vendors only (owner rule: an aggregator is not a provider —
 *  OpenRouter is a transport, not the source of truth for an STT key). The
 *  local entry is the by-address OpenAI-compatible server (e.g.
 *  faster-whisper-server) — endpoint deliberately generic, user edits it. */
export const STT_QUICKSTARTS: SttQuickstart[] = [
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "whisper-1",
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3",
  },
  {
    id: "local",
    label: "Local server",
    // faster-whisper-server's default port — a suggestion the user edits,
    // not a discovery claim (ST-8 owns live discovery later).
    endpoint: "http://127.0.0.1:8000/v1",
    model: "whisper-1",
  },
];

/** Look up one recipe by id (null = unknown id). */
export function getSttQuickstart(id: string): SttQuickstart | null {
  return STT_QUICKSTARTS.find((q) => q.id === id) ?? null;
}
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { appendTokenQuery } from "../mobile-token.js";

/**
 * TPE-18c: narration-library HTTP client (one OGG per message, served by
 * the VT API from the character's assets folder). Raw fetch like the
 * other binary TTS calls (generateTtsSpeech precedent) — gateway-aware
 * via appendTokenQuery.
 */

export interface NarrationLibraryIds {
  characterId: string;
  chatId: string;
  branchId: string;
  messageId: string;
  variantIndex: number;
}

function libraryQuery(ids: NarrationLibraryIds): string {
  const params = new URLSearchParams({
    characterId: ids.characterId,
    chatId: ids.chatId,
    branchId: ids.branchId,
    messageId: ids.messageId,
    variantIndex: String(ids.variantIndex),
  });
  return params.toString();
}

export interface NarrationLibraryClient {
  saveRecording(ids: NarrationLibraryIds, audio: Blob): Promise<{ saved: boolean; leaf: string }>;
  recordingExists(ids: NarrationLibraryIds): Promise<boolean>;
  fetchRecording(ids: NarrationLibraryIds): Promise<Blob | null>;
  deleteRecording(ids: NarrationLibraryIds): Promise<{ deleted: boolean }>;
  revealRecording(ids: NarrationLibraryIds): Promise<{ revealed: boolean }>;
}

async function throwForStatus(response: Response, action: string): Promise<never> {
  const text = await response.text().catch(() => "");
  throw new Error(
    `Narration library ${action} failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
  );
}

const realClient: NarrationLibraryClient = {
  async saveRecording(ids, audio) {
    const baseUrl = getGatewayBaseUrl();
    const form = new FormData();
    form.set("characterId", ids.characterId);
    form.set("chatId", ids.chatId);
    form.set("branchId", ids.branchId);
    form.set("messageId", ids.messageId);
    form.set("variantIndex", String(ids.variantIndex));
    // The .ogg name keeps the multipart part typed audio/ogg (transport
    // derives it from the filename); the server stores its own fixed leaf.
    form.set("audio", new File([audio], "merged.ogg", { type: "audio/ogg" }));
    const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/narrations`), {
      method: "POST",
      body: form,
    });
    if (!response.ok) await throwForStatus(response, "save");
    return (await response.json()) as { saved: boolean; leaf: string };
  },

  async recordingExists(ids) {
    const baseUrl = getGatewayBaseUrl();
    const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/narrations/exists?${libraryQuery(ids)}`));
    if (!response.ok) await throwForStatus(response, "exists check");
    return ((await response.json()) as { exists: boolean }).exists;
  },

  async fetchRecording(ids) {
    const baseUrl = getGatewayBaseUrl();
    const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/narrations/file?${libraryQuery(ids)}`));
    if (response.status === 404) return null;
    if (!response.ok) await throwForStatus(response, "download");
    return response.blob();
  },

  async deleteRecording(ids) {
    const baseUrl = getGatewayBaseUrl();
    const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/narrations?${libraryQuery(ids)}`), {
      method: "DELETE",
    });
    if (!response.ok) await throwForStatus(response, "delete");
    return (await response.json()) as { deleted: boolean };
  },

  async revealRecording(ids) {
    const baseUrl = getGatewayBaseUrl();
    const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/narrations/reveal`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ids }),
    });
    if (!response.ok) await throwForStatus(response, "reveal");
    return (await response.json()) as { revealed: boolean };
  },
};

let clientOverride: NarrationLibraryClient | null = null;

/** Test seam (store-seam precedent): swap the HTTP client, null restores. */
export function __setNarrationLibraryClientForTests(client: NarrationLibraryClient | null): void {
  clientOverride = client;
}

export function narrationLibraryClient(): NarrationLibraryClient {
  return clientOverride ?? realClient;
}

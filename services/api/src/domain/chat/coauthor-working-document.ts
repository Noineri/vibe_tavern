/**
 * Co-Author's turn-local working document.
 *
 * The editor sends only editable card fields. This module overlays those fields
 * onto the server-owned canonical profile so unknown frontmatter, storage
 * identity, and other server-only metadata survive while the prompt and its
 * mutation tools share the exact same live base.
 */
import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import { parseProfileMd, serializeProfileMd, type VtfProfile } from "@vibe-tavern/db";

export interface CoauthorWorkingCharacter {
  firstMessage: string;
  alternateGreetings: string[];
}

export interface CoauthorWorkingDocument {
  profileMd: string;
  character: CoauthorWorkingCharacter;
}

export interface CoauthorProfileCharacterFields {
  tags: string[];
  creatorNotes: string | null;
  description: string;
  scenario: string;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  extensions: Record<string, unknown>;
}

/** Remove the editor-only synthesized GREETINGS section before the profile codec sees it. */
function splitEditorBody(body: string): string {
  const greetingHeading = /^#[ \t]+GREETINGS[ \t]*$/m.exec(body);
  return greetingHeading?.index === undefined ? body : body.slice(0, greetingHeading.index).replace(/\n+$/, "");
}

/**
 * Build the canonical live working document for one co-author request.
 * Empty editor fields deliberately clear their corresponding live card fields;
 * this is a preview base, not Apply, so an empty name is never restored.
 */
export function buildCoauthorWorkingDocument(
  savedProfileMd: string,
  editorState: CoauthorEditorState,
): CoauthorWorkingDocument {
  const saved = parseProfileMd(savedProfileMd);
  const editorBody = parseProfileMd(`---\n---\n${splitEditorBody(editorState.card.body)}`);

  saved.profile.name = editorState.card.name;
  saved.profile.description = editorBody.profile.description;
  saved.profile.scenario = editorBody.profile.scenario;
  saved.profile.mesExample = editorBody.profile.mesExample;

  return {
    profileMd: serializeProfileMd(saved),
    character: {
      firstMessage: editorState.card.greetings[0] ?? "",
      alternateGreetings: editorState.card.greetings.slice(1),
    },
  };
}

/**
 * Map canonical profile fields back onto a character update while retaining
 * server-owned extension keys that the profile codec does not author.
 */
export function mapCoauthorProfileToCharacterFields(
  profile: VtfProfile,
  currentExtensions: Record<string, unknown>,
): CoauthorProfileCharacterFields {
  return {
    tags: profile.tags,
    creatorNotes: profile.creatorNotes,
    description: profile.description,
    scenario: profile.scenario ?? "",
    mesExample: profile.mesExample,
    mesExampleMode: profile.mesExampleMode,
    mesExampleDepth: profile.mesExampleDepth,
    extensions: {
      ...currentExtensions,
      ...(profile.creator !== null ? { creator: profile.creator } : {}),
      ...(profile.characterVersion !== null ? { character_version: profile.characterVersion } : {}),
    },
  };
}

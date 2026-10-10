import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatBranchId } from "@vibe-tavern/domain";
import type { ChatModeAssembleLoaders } from "../../domain/chat/chat-mode-strategy.js";
import type { SkillCatalogEntry } from "../../domain/coauthor/skills/skill-scanner.js";

/**
 * Raw state access handed to non-RP chat-mode strategies (co-author) so they
 * can build their own prompt without going through the RP assembly pipeline.
 * Stateless closures over `this.stores`; RP ignores the handle entirely.
 */
export function buildChatModeLoaders(
	stores: StoreContainer,
	getSkillCatalog: () => Promise<SkillCatalogEntry[]>,
): ChatModeAssembleLoaders {
		return {
			getMessages: async (chatId, branchId, limit) => {
				const chat = await stores.chats.getById(chatId);
				if (!chat) return [];
				const branch = branchId ?? (chat.activeBranchId as ChatBranchId | null);
				if (!branch) return [];
				const msgs = await stores.messages.getMessages(branch);
				return limit && limit > 0 ? msgs.slice(-limit) : msgs;
			},
			getChat: async (chatId) => {
				const chat = await stores.chats.getById(chatId);
				if (!chat) throw new Error(`Chat '${chatId}' was not found.`);
				return chat;
			},
			getCharacter: async (chatId) => {
				const chat = await stores.chats.getById(chatId);
				if (!chat) throw new Error(`Chat '${chatId}' was not found.`);
				const char = await stores.characters.getById(chat.characterId);
				if (!char) throw new Error(`Character '${chat.characterId}' was not found.`);
				return char;
			},
			getProfileMdText: (characterId) => stores.characters.getProfileMdText(characterId),
			getCoauthorContextItems: async (chatId) => {
				// CE-C1: resolve the entities the user EXPLICITLY pinned to this chat
				// (right-panel picker → chats.coauthorContextLinks) into read-only
				// reference blocks. Generalizes CA-13 (lorebook-only) to
				// character/persona/lorebook/script. NOT RP keyword activation.
				const chat = await stores.chats.getById(chatId);
				if (!chat || chat.coauthorContextLinks.length === 0) return [];
				// The active character is already rendered as `currentCard`; skip a
				// pinned link to it to avoid 2x-token duplication.
				const out: import("../../domain/chat/chat-mode-strategy.js").CoauthorContextItem[] = [];
				for (const link of chat.coauthorContextLinks) {
					if (link.targetType === 'character') {
						if (link.targetId === chat.characterId) continue;
						const c = await stores.characters.getById(link.targetId);
						if (!c) continue;
						const profile = await stores.characters.getProfileMdText(c.id as unknown as import("@vibe-tavern/domain").CharacterId);
						out.push({ type: 'character', id: c.id, title: c.name, content: profile });
					} else if (link.targetType === 'persona') {
						const p = await stores.personas.getById(link.targetId);
						if (!p) continue;
						out.push({ type: 'persona', id: p.id, title: p.name, content: p.description });
					} else if (link.targetType === 'lorebook') {
						const lb = await stores.lorebooks.getLorebook(link.targetId);
						if (!lb?.enabled) continue;
						const entries = await stores.lorebooks.listEntries(link.targetId);
						for (const e of entries.filter((e) => e.enabled)) {
							out.push({ type: 'lorebook', id: e.id, title: e.title, content: e.content });
						}
					} else {
						// script
						const sc = await stores.scripts.getById(link.targetId);
						if (!sc) continue;
						const body = sc.description.trim()
							? `${sc.description.trim()}\n\n\`\`\`js\n${sc.code}\n\`\`\``
							: `\`\`\`js\n${sc.code}\n\`\`\``;
						out.push({ type: 'script', id: sc.id, title: sc.name, content: body });
					}
				}
				// Dedupe by type+id (a book bound twice shouldn't double-inject).
				const seen = new Set<string>();
				return out.filter((it) => {
					const key = `${it.type}:${it.id}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
			},
			getChatSummaries: async (chatId, branchId) => {
				return stores.chatSummaries.listByChatBranch(chatId, branchId);
			},
			getCoauthorBoundResources: async (characterId) => {
				// CE-C2/C3: the character's M:N-bound lorebooks + scripts as awareness
				// metadata (name + entry titles / name + description) — NOT full
				// content (Level 1) and NOT RP keyword activation. Mirrors exactly
				// what BoundResourcesField shows the user as 'bound' (links-only via
				// listLorebooksLinkedToTarget / listScriptsLinkedToTarget).
				const [boundLorebooks, boundScripts] = await Promise.all([
					stores.lorebooks.listLorebooksLinkedToTarget('character', characterId as string),
					stores.scripts.listScriptsLinkedToTarget('character', characterId as string),
				]);
				const lorebookItems = await Promise.all(
					boundLorebooks.map(async (lb) => ({
						id: lb.id,
						name: lb.name,
						// Level-2 metadata only: title + stable id, never content. The id
						// lets CE-B1's cross-turn tools target this persisted entry.
						entries: (await stores.lorebooks.listEntries(lb.id))
							.filter((e) => e.enabled)
							.map((e) => ({ id: e.id, title: e.title })),
					})),
				);
				const scriptItems = boundScripts.map((sc) => ({
					id: sc.id,
					name: sc.name,
					// Description is the human-written summary; the CODE stays out.
					summary: sc.description.trim(),
				}));
				return { lorebooks: lorebookItems, scripts: scriptItems };
			},
			getCoauthorUserModules: async () => {
				// CS-24: user-created modules (editable). Seed modules never come from
				// here — the registry loads those from disk. The row carries
				// createdAt/updatedAt which the registry's toUserModule drops.
				return stores.coauthorModules.list();
			},
			getSkillCatalog: () => getSkillCatalog(),
		};
	}

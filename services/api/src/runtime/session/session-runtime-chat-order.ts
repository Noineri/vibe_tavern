import type { ChatId } from "@vibe-tavern/domain";
import type { ChatStore } from "@vibe-tavern/db";

/**
 * Interface for managing the ordered list of chat IDs.
 * Order is held in memory (a cached array), seeded by chatStore.listAll()
 * (sorted by updatedAt DESC) and mutated only by add (prepend on create)
 * and remove (on delete). Re-seeded via refresh() after structural changes.
 */
export interface IChatOrder {
	add(chatId: ChatId): void;
	remove(chatId: ChatId): void;
	readonly items: readonly ChatId[];
}

export class ChatOrderService implements IChatOrder {
	private stale = true;
	private cached: ChatId[] = [];

	constructor(private readonly chatStore: ChatStore) {}

	add(chatId: ChatId): void {
		this.cached.unshift(chatId);
		this.stale = false;
	}

	remove(chatId: ChatId): void {
		const idx = this.cached.indexOf(chatId);
		if (idx !== -1) this.cached.splice(idx, 1);
	}

	get items(): readonly ChatId[] {
		if (this.stale) {
			throw new Error("ChatOrder: items accessed before seed/refresh. Call seed() or refresh() first.");
		}
		return this.cached;
	}

	/**
	 * Seed the in-memory order from chatStore.listAll() (updatedAt DESC).
	 * Called at startup.
	 */
	async seed(): Promise<void> {
		await this.refresh();
	}

	/**
	 * Re-read order from DB. Used after structural changes (e.g. system character promotion).
	 */
	async refresh(): Promise<void> {
		const allChats = await this.chatStore.listAll();
		this.cached = allChats.map((chat) => chat.id as ChatId);
		this.stale = false;
	}
}

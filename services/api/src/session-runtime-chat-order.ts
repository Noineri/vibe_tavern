import type { ChatId } from "@vibe-tavern/domain";
import type { ChatStore } from "@vibe-tavern/db";

/**
 * Interface for managing the ordered list of chat IDs.
 * Order is persisted in DB via lastAccessedAt column.
 */
export interface IChatOrder {
	add(chatId: ChatId): void;
	remove(chatId: ChatId): void;
	moveToFront(chatId: ChatId): void;
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

	moveToFront(chatId: ChatId): void {
		const idx = this.cached.indexOf(chatId);
		if (idx > 0) {
			this.cached.splice(idx, 1);
			this.cached.unshift(chatId);
		}
	}

	get items(): readonly ChatId[] {
		if (this.stale) {
			throw new Error("ChatOrder: items accessed before seed/refresh. Call seed() or refresh() first.");
		}
		return this.cached;
	}

	/**
	 * Load chat order from DB (sorted by lastAccessedAt DESC).
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

	/**
	 * Legacy alias for refresh().
	 * @deprecated Use refresh() instead.
	 */
	async rebuild(): Promise<void> {
		await this.refresh();
	}
}

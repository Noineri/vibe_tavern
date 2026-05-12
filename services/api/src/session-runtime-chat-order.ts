import type { ChatId } from "@rp-platform/domain";
import type { ChatStore } from "@rp-platform/db";

/**
 * Interface for managing the ordered list of chat IDs.
 * Shared mutable state extracted from SessionRuntime to avoid
 * direct array mutation across multiple modules.
 */
export interface IChatOrder {
	add(chatId: ChatId): void;
	remove(chatId: ChatId): void;
	readonly items: readonly ChatId[];
}

export class ChatOrderService implements IChatOrder {
	private readonly _items: ChatId[] = [];

	constructor(private readonly chatStore: ChatStore) {}

	add(chatId: ChatId): void {
		this._items.unshift(chatId);
	}

	remove(chatId: ChatId): void {
		const idx = this._items.indexOf(chatId);
		if (idx !== -1) this._items.splice(idx, 1);
	}

	get items(): readonly ChatId[] {
		return this._items;
	}

	/**
	 * Rebuild chat order from DB. Used after system character promotion.
	 */
	async rebuild(): Promise<void> {
		this._items.length = 0;
		const allChats = await this.chatStore.listAll();
		this._items.push(...allChats.map((chat) => chat.id as ChatId));
	}

	/**
	 * Initial seed from DB on startup.
	 */
	async seed(): Promise<void> {
		const existingChats = await this.chatStore.listAll();
		if (existingChats.length > 0) {
			this._items.push(...existingChats.map((chat) => chat.id as ChatId));
		}
	}
}

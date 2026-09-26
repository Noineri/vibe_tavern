import * as schemas from '@vibe-tavern/api-contracts';
import type { FlyTribunalSettingsStore, FlyTribunalStore } from '@vibe-tavern/db';
import type { FlyTribunalRuntimeApi } from '../contract/runtime-api.js';

/**
 * Fly Tribunal route adapter (FT-4).
 *
 * The db stores own typed persistence; this adapter is the dependency-layer
 * boundary that validates their projections against the canonical API Zod
 * contracts on BOTH reads and writes. It keeps routes free of store imports.
 */
interface FlyTribunalStores {
  flyTribunal: FlyTribunalStore;
  flyTribunalSettings: FlyTribunalSettingsStore;
}

export class FlyTribunalAdapter implements FlyTribunalRuntimeApi {
  constructor(private readonly stores: FlyTribunalStores) {}

  async getSettings(): Promise<schemas.FlyTribunalSettings> {
    return schemas.flyTribunalSettingsSchema.parse(await this.stores.flyTribunalSettings.get());
  }

  async putSettings(settings: schemas.FlyTribunalSettings): Promise<schemas.FlyTribunalSettings> {
    const valid = schemas.flyTribunalSettingsSchema.parse(settings);
    return schemas.flyTribunalSettingsSchema.parse(await this.stores.flyTribunalSettings.put(valid));
  }

  async getMemory(
    scope: schemas.FlyMemoryScope,
    chatId?: string,
  ): Promise<schemas.FlyMemoryGetResponse> {
    if (scope === 'chat') {
      if (!chatId) throw new Error('Fly Tribunal chat memory requires chatId');
      return schemas.flyMemoryGetResponseSchema.parse(await this.stores.flyTribunal.get('chat', chatId));
    }
    if (chatId !== undefined) throw new Error('Fly Tribunal global memory must not carry chatId');
    return schemas.flyMemoryGetResponseSchema.parse(await this.stores.flyTribunal.get('global'));
  }

  async putMemory(memory: schemas.FlyMemoryPut): Promise<schemas.FlyMemoryGetResponse> {
    const valid = schemas.flyMemoryPutSchema.parse(memory);
    if (valid.scope === 'chat') {
      if (!valid.chatId) throw new Error('Fly Tribunal chat memory requires chatId');
      return schemas.flyMemoryGetResponseSchema.parse(await this.stores.flyTribunal.put({
        scope: 'chat',
        chatId: valid.chatId,
        schemaVersion: valid.schemaVersion,
        precedentCount: valid.precedentCount,
        weights: valid.weights,
      }));
    }
    return schemas.flyMemoryGetResponseSchema.parse(await this.stores.flyTribunal.put({
      scope: 'global',
      schemaVersion: valid.schemaVersion,
      precedentCount: valid.precedentCount,
      weights: valid.weights,
    }));
  }
}

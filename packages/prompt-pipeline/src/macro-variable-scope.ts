/**
 * Mutable macro state owned by exactly one prompt assembly.
 * Local and global names are separate namespaces; neither persists across turns
 * or chats. A scope may be shared by the lore-activation and assembly engines.
 */
export class MacroVariableScope {
  readonly local = new Map<string, string>();
  readonly global = new Map<string, string>();

  reset(): void {
    this.local.clear();
    this.global.clear();
  }
}

export function getVariableStore(scope: MacroVariableScope, global: boolean): Map<string, string> {
  return global ? scope.global : scope.local;
}

export function parseVariableValue(value: string): Record<string, unknown> | unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return {};
}

export function readVariableKey(store: Map<string, string>, name: string, key: string): string {
  const value = parseVariableValue(store.get(name) ?? "");
  const result = Array.isArray(value) ? value[Number(key)] : value[key];
  return result == null ? "" : String(result);
}

export function writeVariableKey(store: Map<string, string>, name: string, key: string, value: string): void {
  const stored = store.get(name);
  const object = stored == null ? createKeyContainer(key) : parseVariableValue(stored);
  if (Array.isArray(object)) {
    object[Number(key)] = value;
  } else {
    object[key] = value;
  }
  store.set(name, JSON.stringify(object));
}

function createKeyContainer(key: string): Record<string, unknown> | unknown[] {
  return /^\d+$/.test(key) ? [] : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

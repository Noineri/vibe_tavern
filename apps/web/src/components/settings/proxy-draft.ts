import type { ProxyRecord } from "../../api/types.js";

export interface ProxyDraft {
  id: string | null;
  name: string;
  url: string;
  username: string;
  password: string;
  hasStoredPassword: boolean;
  clearStoredPassword: boolean;
}
export function proxyToDraft(proxy: ProxyRecord): ProxyDraft {
  return { id: proxy.id, name: proxy.name, url: proxy.url, username: proxy.username ?? "", password: "", hasStoredPassword: proxy.hasStoredPassword, clearStoredPassword: false };
}
export function emptyProxyDraft(): ProxyDraft {
  return { id: null, name: "", url: "", username: "", password: "", hasStoredPassword: false, clearStoredPassword: false };
}
/** Omitting password preserves a stored secret; null explicitly removes it. */
export function buildProxyWrite(draft: ProxyDraft) {
  return {
    name: draft.name.trim(), url: draft.url.trim(), username: draft.username.length > 0 ? draft.username : null,
    password: draft.password.length > 0 ? draft.password : (draft.clearStoredPassword ? null : undefined),
  };
}

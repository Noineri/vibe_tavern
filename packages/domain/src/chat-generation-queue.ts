/** Durable generate-more job states, shared by storage and the wire contract. */
export const CHAT_GENERATION_JOB_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type ChatGenerationJobStatus = typeof CHAT_GENERATION_JOB_STATUSES[number];

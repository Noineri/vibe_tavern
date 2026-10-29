/** Map the validated send body's optional Dice commit intent (the wire shape
 *  `{diceMode, pendingRevision}`, both-or-neither enforced by the Zod refine)
 *  to the internal `diceCommit` the orchestrator threads into prepareLiveTurn.
 *  Absent => undefined (no-Dice send behavior). DICE-B11. */
export function resolveDiceCommit(body: { diceMode?: "normal" | "immersive"; pendingRevision?: number }): { mode: "normal" | "immersive"; pendingRevision: number } | undefined {
	if (body.diceMode !== undefined && body.pendingRevision !== undefined) {
		return { mode: body.diceMode, pendingRevision: body.pendingRevision };
	}
	return undefined;
}

/** Map the validated send body's optional experience attachment commit intent
 *  (the wire shape `{experienceAttachmentId, experienceQueueRevision,
 *  experienceSessionRevision}`, all-or-none enforced by the Zod refine) to the
 *  internal `experienceCommit` the orchestrator threads into prepareLiveTurn.
 *  Absent => undefined (no-experience send behavior). IR-51. Carries ONLY the
 *  identifiers of an already-stored queued attachment — never raw state. */
export function resolveExperienceCommit(body: { experienceAttachmentId?: string; experienceQueueRevision?: number; experienceSessionRevision?: number }): { attachmentId: string; queueRevision: number; sessionRevision: number } | undefined {
	if (body.experienceAttachmentId !== undefined && body.experienceQueueRevision !== undefined && body.experienceSessionRevision !== undefined) {
		return { attachmentId: body.experienceAttachmentId, queueRevision: body.experienceQueueRevision, sessionRevision: body.experienceSessionRevision };
	}
	return undefined;
}

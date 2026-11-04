import { z } from "zod";

/**
 * SM-9a consent-scoped diagnostics request bodies.
 *
 * A generation selection is the FULL identity tuple of one stored attempt —
 * every field required (variantId nullable: greeting traces have no producing
 * swipe). The identity is re-verified against the stored trace server-side;
 * these schemas only guarantee the request shape is complete and unambiguous.
 */

const traceIdField = z.string().min(1);
const identityField = z.string().min(1);

export const diagnosticsSelectionSchema = z.object({
  traceId: traceIdField,
  chatId: identityField,
  branchId: identityField,
  messageId: identityField,
  variantId: identityField.nullable(),
});

/** POST /api/diagnostics/preview — inspect one selected generation's redacted
 * capture (before any save confirmation). */
export const diagnosticsPreviewRequestSchema = z.object({
  selection: diagnosticsSelectionSchema,
});

/** POST /api/diagnostics — no body / no `attach` = the technical-only
 * default; `confirmed` is enforced server-side (an unconfirmed attach is a
 * named rejection, never a silent downgrade nor a silent content zip). */
export const diagnosticsZipRequestSchema = z.object({
  attach: z
    .object({
      selection: diagnosticsSelectionSchema,
      confirmed: z.boolean(),
    })
    .optional(),
});

export type DiagnosticsSelectionInput = z.infer<typeof diagnosticsSelectionSchema>;
export type DiagnosticsPreviewRequest = z.infer<typeof diagnosticsPreviewRequestSchema>;
export type DiagnosticsZipRequest = z.infer<typeof diagnosticsZipRequestSchema>;

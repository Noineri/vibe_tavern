import { normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";

/** Decode the portable recursive DTO through the same authority as card import. */
export function readTrackerTemplateResponse(value: unknown): TrackerTemplate {
  const template = normalizeTrackerTemplate(value);
  if (template === null) throw new Error("Invalid tracker template response");
  return template;
}

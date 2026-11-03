import { z } from "zod";

export const MAX_USER_THEME_BYTES = 1024 * 1024;
export const USER_THEME_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const userThemeSlugSchema = z.string().min(1).max(80).regex(USER_THEME_SLUG_PATTERN);
export const uploadUserThemeSchema = z.object({
  name: z.string().trim().min(1).max(160).regex(/\.css$/i).refine((name) => !/[/\\\u0000-\u001f]/.test(name)),
  css: z.string().min(1).max(MAX_USER_THEME_BYTES),
});
export const userThemeSummarySchema = z.object({ id: userThemeSlugSchema, name: z.string() });
export const userThemeSchema = userThemeSummarySchema.extend({ css: z.string() });
export type UploadUserTheme = z.infer<typeof uploadUserThemeSchema>;
export type UserThemeSummary = z.infer<typeof userThemeSummarySchema>;
export type UserTheme = z.infer<typeof userThemeSchema>;

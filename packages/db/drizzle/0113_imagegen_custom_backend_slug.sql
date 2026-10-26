-- Custom image-gen profiles get their own backend slug (owner ruling
-- 2026-10-15, IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 9): a Custom
-- profile is an `openai-images` row WITHOUT a preset (`preset_id` NULL —
-- the editor's Custom segment). It moves to `openai-images-custom` (free
-- W×H, no OpenAI size grid); OpenAI-preset rows (`preset_id` 'openai') stay.
-- The profile's capability snapshot follows the new slug's size support
-- (free) — the editor's size controls read the snapshot; an unreadable
-- snapshot restarts from `{}` (the store's degraded-flags reading).
-- Endpoint, key, model and params are untouched.
UPDATE `image_gen_profiles`
SET `backend` = 'openai-images-custom',
    `capabilities_json` = json_set(
      CASE WHEN json_valid(`capabilities_json`) THEN `capabilities_json` ELSE '{}' END,
      '$.sizeSupport',
      json('{"kind":"free"}')
    )
WHERE `backend` = 'openai-images' AND `preset_id` IS NULL;
--> statement-breakpoint
-- Learned prompt caps are keyed by (backend, model_id), and an
-- `openai-images` cap cannot tell which profile taught it — copy each one to
-- the Custom slug so neither side loses it (caps are advisory and
-- self-healing; a stale copy is deleted by the next longer success).
INSERT OR IGNORE INTO `image_gen_prompt_caps` (`backend`, `model_id`, `max_prompt_chars`, `learned_at`)
SELECT 'openai-images-custom', `model_id`, `max_prompt_chars`, `learned_at` FROM `image_gen_prompt_caps` WHERE `backend` = 'openai-images';

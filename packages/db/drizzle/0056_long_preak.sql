ALTER TABLE `tts_profiles` ADD `api_key` text;--> statement-breakpoint
ALTER TABLE `tts_profiles` ADD `provider_ref` text;--> statement-breakpoint
-- TE2-16 backfill: lift the secret out of config_json into the typed column,
-- then strip it from the blob. json_type guards keep absent/null values from
-- writing NULL-over-NULL and trim() drops whitespace-only keys.
UPDATE `tts_profiles` SET `api_key` = trim(json_extract(`config_json`, '$.apiKey'))
WHERE json_type(`config_json`, '$.apiKey') = 'text' AND trim(json_extract(`config_json`, '$.apiKey')) != '';
--> statement-breakpoint
UPDATE `tts_profiles` SET `provider_ref` = json_extract(`config_json`, '$.providerRef')
WHERE json_type(`config_json`, '$.providerRef') = 'text' AND json_extract(`config_json`, '$.providerRef') != '';
--> statement-breakpoint
UPDATE `tts_profiles` SET `config_json` = json_remove(`config_json`, '$.apiKey', '$.providerRef')
WHERE json_type(`config_json`, '$.apiKey') = 'text' OR json_type(`config_json`, '$.providerRef') = 'text';

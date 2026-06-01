-- Persist provider-level logit bias entries for supported OpenAI-compatible backends.
ALTER TABLE `provider_profiles` ADD COLUMN `logit_bias_json` text;

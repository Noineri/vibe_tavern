-- Scope taxonomy collapse 4 → 3 (L2): the entity-binding picker made
-- 'character' and 'persona' the same mechanic split across two scope names.
-- Both merge into 'entity' (global / entity / chat). The owner FK columns
-- (character_id / persona_id) are the typed owner and are NOT touched —
-- an entity book keeps exactly the FK it was bound to, so no binding is
-- lost and activation (home FK ∪ junction links) is preserved verbatim.
UPDATE `lorebooks` SET `scope_type` = 'entity' WHERE `scope_type` IN ('character', 'persona');
--> statement-breakpoint
UPDATE `scripts` SET `scope_type` = 'entity' WHERE `scope_type` IN ('character', 'persona');

-- Simba's agent.brain_chain overrode routing_policies, so Cursor never ran.
-- Align the agent row with the tier-0 policy: claude-b, claude-a, cursor, codex,
-- then the free rungs so a total subscription outage still has somewhere to go.

UPDATE agents
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'cursor'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'codex'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'opencode'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'ollama'
       )
 WHERE slug = 'simba'
   AND retired_at IS NULL;

UPDATE routing_policies
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'cursor'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'codex'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'opencode'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'ollama'
       )
 WHERE applies_to_tier = 0;

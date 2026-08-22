-- Register the Discord export as a knowledge source.
--
-- readDiscordExport shipped without this and the command it advertises failed
-- outright: ingestSource looks the slug up in knowledge_sources and throws
-- "unknown knowledge source: discord-export". The reader was tested directly
-- and the command it is reached through was not, which is the whole distance
-- between a function that works and a feature that does.
--
-- The kind CHECK has to widen first. It enumerates the shapes an ingest can
-- take, and a Discord archive is a new one - conversations per channel, with
-- DMs and server channels distinguished by whether a guild is present.

ALTER TABLE knowledge_sources DROP CONSTRAINT knowledge_sources_kind_check;
ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_kind_check
  CHECK (kind = ANY (ARRAY[
    'chatgpt_export', 'claude_export', 'discord_export', 'obsidian',
    'knowledge_api', 'repo', 'manual', 'session_history'
  ]));

INSERT INTO knowledge_sources (slug, kind, name, config)
VALUES ('discord-export', 'discord_export', 'Discord data export', '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

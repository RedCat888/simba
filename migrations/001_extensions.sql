-- 001_extensions.sql
-- Base extensions. pgvector 0.8.1 is built from source against this cluster
-- (see scripts/build_pgvector.bat); it is not available from any binary feed
-- on Windows, so a clean rebuild is required after a PostgreSQL major upgrade.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Schema migration bookkeeping.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    checksum    text
);

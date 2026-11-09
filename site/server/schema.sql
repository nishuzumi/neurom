-- schema.sql — the names of the entries (ticket 07). One row per name that a player set. `cleared_at` is NULL while
-- the name is active. An admin clear fills `cleared_at` and keeps the row, so the history stays readable.
-- Each statement ends with `;` on its own line. db.js runs the statements one by one (the Neon HTTP driver takes one
-- statement per query).
CREATE TABLE IF NOT EXISTS entry_names (
  id          bigserial PRIMARY KEY,
  chain_id    integer     NOT NULL,
  module      text        NOT NULL,
  name        text        NOT NULL,
  name_key    text        NOT NULL,
  owner       text        NOT NULL,
  signature   text        NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS entry_names_active_module ON entry_names (chain_id, module) WHERE cleared_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entry_names_active_name ON entry_names (chain_id, name_key) WHERE cleared_at IS NULL;

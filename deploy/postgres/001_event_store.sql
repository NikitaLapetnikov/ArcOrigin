BEGIN;

CREATE TABLE IF NOT EXISTS arc_blocks (
  block_number BIGINT PRIMARY KEY,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp BIGINT NOT NULL CHECK (block_timestamp >= 0)
);

CREATE TABLE IF NOT EXISTS arc_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT CHECK (token_address IS NULL OR token_address ~ '^0x[0-9a-f]{40}$'),
  pool_address TEXT CHECK (pool_address IS NULL OR pool_address ~ '^0x[0-9a-f]{40}$'),
  position_id NUMERIC(78, 0),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp BIGINT NOT NULL CHECK (block_timestamp >= 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS arc_events_token_block_idx
  ON arc_events (token_address, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS arc_events_pool_block_idx
  ON arc_events (pool_address, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS arc_events_name_block_idx
  ON arc_events (event_name, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS arc_events_position_block_idx
  ON arc_events (position_id, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS arc_events_swap_time_idx
  ON arc_events (token_address, block_timestamp DESC)
  WHERE event_name = 'Swap';

CREATE TABLE IF NOT EXISTS arc_markets (
  token_address TEXT PRIMARY KEY CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  factory_address TEXT NOT NULL CHECK (factory_address ~ '^0x[0-9a-f]{40}$'),
  pool_address TEXT NOT NULL UNIQUE CHECK (pool_address ~ '^0x[0-9a-f]{40}$'),
  creator_address TEXT NOT NULL CHECK (creator_address ~ '^0x[0-9a-f]{40}$'),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  position_id NUMERIC(78, 0) NOT NULL UNIQUE,
  automatic_buyback BOOLEAN NOT NULL DEFAULT FALSE,
  launch_block BIGINT NOT NULL,
  launch_timestamp BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS arc_markets_creator_idx ON arc_markets (creator_address);
CREATE INDEX IF NOT EXISTS arc_markets_launch_block_idx ON arc_markets (launch_block DESC);

CREATE TABLE IF NOT EXISTS arc_holder_balances (
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  holder_address TEXT NOT NULL CHECK (holder_address ~ '^0x[0-9a-f]{40}$'),
  balance NUMERIC(78, 0) NOT NULL,
  updated_block BIGINT NOT NULL,
  PRIMARY KEY (token_address, holder_address)
);

CREATE INDEX IF NOT EXISTS arc_holder_balances_rank_idx
  ON arc_holder_balances (token_address, balance DESC)
  WHERE balance > 0;

CREATE TABLE IF NOT EXISTS arc_indexer_state (
  stream TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  last_hash TEXT CHECK (last_hash IS NULL OR last_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

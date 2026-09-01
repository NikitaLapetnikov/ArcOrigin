BEGIN;

-- Protocol analytics filters by event type and time before aggregating. These
-- partial indexes keep the hot path bounded as the general event table grows.
CREATE INDEX IF NOT EXISTS arc_events_swap_global_time_idx
  ON arc_events (block_timestamp DESC, token_address)
  WHERE event_name = 'Swap';

CREATE INDEX IF NOT EXISTS arc_events_buyback_global_time_idx
  ON arc_events (block_timestamp DESC, token_address)
  WHERE event_name = 'BuybackExecuted';

CREATE INDEX IF NOT EXISTS arc_markets_launch_time_idx
  ON arc_markets (launch_timestamp DESC);

CREATE INDEX IF NOT EXISTS arc_holder_balances_active_wallet_idx
  ON arc_holder_balances (holder_address, token_address)
  WHERE balance > 0;

COMMIT;

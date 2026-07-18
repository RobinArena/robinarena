ALTER TABLE arena_positions
  ADD COLUMN source_order_id uuid;

ALTER TABLE arena_trades
  ADD COLUMN source_order_id uuid;

UPDATE arena_positions position
SET source_order_id = (
  SELECT orders.id
  FROM arena_orders orders
  WHERE orders.position_id = position.id
    AND orders.agent_id = position.agent_id
    AND orders.symbol = position.symbol
    AND orders.side = 'buy'
    AND orders.broker_order_id IS NOT NULL
    AND orders.accounted_quantity > 0
    AND orders.accounted_notional > 0
    AND orders.average_fill_price > 0
  ORDER BY orders.created_at
  LIMIT 1
);

UPDATE arena_trades trade
SET source_order_id = (
  SELECT orders.id
  FROM arena_orders orders
  WHERE orders.position_id = trade.position_id
    AND orders.agent_id = trade.agent_id
    AND orders.symbol = trade.symbol
    AND orders.broker_order_id IS NOT NULL
    AND orders.accounted_quantity > 0
    AND orders.accounted_notional > 0
    AND orders.average_fill_price > 0
  ORDER BY
    CASE WHEN orders.side = 'buy' THEN 0 ELSE 1 END,
    orders.created_at
  LIMIT 1
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM arena_positions WHERE source_order_id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM arena_trades WHERE source_order_id IS NULL
  ) THEN
    RAISE EXCEPTION 'arena contains a position or trade without a reconciled Robinhood fill';
  END IF;
END
$$;

ALTER TABLE arena_positions
  ALTER COLUMN source_order_id SET NOT NULL,
  ADD CONSTRAINT arena_positions_source_order_fk
    FOREIGN KEY (source_order_id) REFERENCES arena_orders(id) ON DELETE RESTRICT;

ALTER TABLE arena_trades
  ALTER COLUMN source_order_id SET NOT NULL,
  ADD CONSTRAINT arena_trades_source_order_fk
    FOREIGN KEY (source_order_id) REFERENCES arena_orders(id) ON DELETE RESTRICT;

ALTER TABLE arena_orders
  ADD CONSTRAINT arena_orders_fill_evidence_check
  CHECK (
    accounted_quantity = 0
    OR (
      broker_order_id IS NOT NULL
      AND accounted_notional > 0
      AND average_fill_price > 0
    )
  );

CREATE INDEX arena_positions_source_order_idx
  ON arena_positions (source_order_id);

CREATE INDEX arena_trades_source_order_idx
  ON arena_trades (source_order_id);

CREATE FUNCTION verify_arena_broker_fill_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_side text;
BEGIN
  SELECT orders.side
  INTO source_side
  FROM arena_orders orders
  WHERE orders.id = NEW.source_order_id
    AND orders.agent_id = NEW.agent_id
    AND orders.symbol = NEW.symbol
    AND orders.broker_order_id IS NOT NULL
    AND orders.accounted_quantity > 0
    AND orders.accounted_notional > 0
    AND orders.average_fill_price > 0;

  IF source_side IS NULL THEN
    RAISE EXCEPTION 'arena records require a reconciled Robinhood fill from the same model and symbol';
  END IF;

  IF (
    TG_TABLE_NAME = 'arena_positions'
    OR (TG_TABLE_NAME = 'arena_trades' AND NEW.status = 'open')
  ) AND source_side <> 'buy' THEN
    RAISE EXCEPTION 'open arena positions and trades require a reconciled Robinhood buy fill';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER arena_positions_verify_broker_fill
AFTER INSERT OR UPDATE ON arena_positions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_arena_broker_fill_source();

CREATE CONSTRAINT TRIGGER arena_trades_verify_broker_fill
AFTER INSERT OR UPDATE ON arena_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_arena_broker_fill_source();

CREATE FUNCTION protect_arena_broker_fill_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM arena_positions WHERE source_order_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM arena_trades WHERE source_order_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'cannot delete Robinhood fill evidence referenced by arena records';
    END IF;
    RETURN OLD;
  END IF;

  IF (
    EXISTS (
      SELECT 1
      FROM arena_positions position
      WHERE position.source_order_id = NEW.id
        AND (
          NEW.agent_id <> position.agent_id
          OR NEW.symbol <> position.symbol
          OR NEW.side <> 'buy'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM arena_trades trade
      WHERE trade.source_order_id = NEW.id
        AND (
          NEW.agent_id <> trade.agent_id
          OR NEW.symbol <> trade.symbol
          OR (trade.status = 'open' AND NEW.side <> 'buy')
        )
    )
    OR (
      (
        EXISTS (SELECT 1 FROM arena_positions WHERE source_order_id = NEW.id)
        OR EXISTS (SELECT 1 FROM arena_trades WHERE source_order_id = NEW.id)
      )
      AND (
        NEW.broker_order_id IS NULL
        OR NEW.accounted_quantity <= 0
        OR NEW.accounted_notional <= 0
        OR NEW.average_fill_price <= 0
      )
    )
  ) THEN
    RAISE EXCEPTION 'cannot alter Robinhood fill evidence referenced by arena records';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER arena_orders_protect_fill_evidence
BEFORE UPDATE OR DELETE ON arena_orders
FOR EACH ROW
EXECUTE FUNCTION protect_arena_broker_fill_source();

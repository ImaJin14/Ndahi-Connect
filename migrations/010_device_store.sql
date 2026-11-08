-- Store entities use the existing transactional normalized payload store.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS store_product_sku_unique
ON events (lower(payload->>'sku')) WHERE kind = 'store_product';
CREATE UNIQUE INDEX IF NOT EXISTS store_order_checkout_unique
ON events ((payload->>'checkoutKeyHash')) WHERE kind = 'store_order';
CREATE UNIQUE INDEX IF NOT EXISTS store_payment_id_unique
ON events ((payload->'payment'->>'id')) WHERE kind = 'store_order';
CREATE UNIQUE INDEX IF NOT EXISTS store_payment_provider_reference_unique
ON events ((payload->'payment'->>'provider'), (payload->'payment'->>'providerReference'))
WHERE kind = 'store_order' AND payload->'payment'->>'providerReference' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS store_operation_key_unique
ON events ((payload->>'key')) WHERE kind = 'store_operation';
COMMIT;

-- Lab source for PostgreSQL: a small shop, deterministic so counts are the same
-- on every machine. Runs once, when the pg-lab volume is first initialised.
--
-- movy_src  seeded, the database Movy migrates FROM
-- movy_dst  empty, a ready destination for PG->PG
--
-- Kept to types every Pair translates today (serial, varchar, text, numeric,
-- timestamp, boolean). A fixture that trips a translator gap would make the
-- live e2e fail for a reason that has nothing to do with the stack.

CREATE DATABASE movy_src;
CREATE DATABASE movy_dst;

\connect movy_src

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  email       varchar(255) NOT NULL UNIQUE,
  full_name   varchar(120) NOT NULL,
  -- Self-referencing FK: the planner must load a table that depends on itself.
  referred_by integer REFERENCES customers (id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         varchar(32) NOT NULL UNIQUE,
  name        varchar(200) NOT NULL,
  price       numeric(10, 2) NOT NULL,
  description text
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  placed_at   timestamp NOT NULL,
  total       numeric(12, 2) NOT NULL DEFAULT 0,
  note        text
);
CREATE INDEX orders_customer_idx ON orders (customer_id);

CREATE TABLE order_items (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL REFERENCES orders (id),
  product_id  integer NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL,
  unit_price  numeric(10, 2) NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

INSERT INTO customers (email, full_name, referred_by, is_active, created_at)
SELECT 'customer' || i || '@example.test',
       'Customer ' || i,
       CASE WHEN i > 10 AND i % 7 = 0 THEN i / 7 END,
       i % 13 <> 0,
       timestamp '2025-01-01' + (i || ' minutes')::interval
FROM generate_series(1, 2000) AS i;

INSERT INTO products (sku, name, price, description)
SELECT 'SKU-' || lpad(i::text, 5, '0'),
       'Product ' || i,
       round((5 + (i % 50) * 3.25)::numeric, 2),
       CASE WHEN i % 4 = 0 THEN NULL ELSE 'Description of product ' || i END
FROM generate_series(1, 200) AS i;

INSERT INTO orders (customer_id, placed_at, total, note)
SELECT 1 + (i % 2000),
       timestamp '2025-02-01' + (i || ' hours')::interval,
       round(((i % 97) * 4.5)::numeric, 2),
       CASE WHEN i % 10 = 0 THEN 'gift' END
FROM generate_series(1, 5000) AS i;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT 1 + (i % 5000),
       1 + (i % 200),
       1 + (i % 5),
       round((5 + (i % 50) * 3.25)::numeric, 2)
FROM generate_series(1, 15000) AS i;

-- A sequence BEHIND its own MAX(id): what a dump restore that copied rows
-- without advancing sequences leaves. Step 9 must reseed the destination from
-- MAX(id), not copy this counter, or the first insert after a PG->PG run fails
-- on a duplicate key.
SELECT setval('orders_id_seq', 10);

ANALYZE;

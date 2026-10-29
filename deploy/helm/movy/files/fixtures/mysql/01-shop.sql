-- Lab source for MySQL: the same shop as docker/fixtures/postgres, with the
-- same deterministic rows, so a count on either side means the same thing.
-- Runs once, when the mysql-lab volume is first initialised.

CREATE DATABASE movy_src;
CREATE DATABASE movy_dst;

USE movy_src;

CREATE TABLE customers (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  full_name   VARCHAR(120) NOT NULL,
  referred_by INT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customers_referred_by_fk FOREIGN KEY (referred_by) REFERENCES customers (id)
) ENGINE = InnoDB;

CREATE TABLE products (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  sku         VARCHAR(32) NOT NULL UNIQUE,
  name        VARCHAR(200) NOT NULL,
  price       DECIMAL(10, 2) NOT NULL,
  description TEXT NULL
) ENGINE = InnoDB;

CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  placed_at   DATETIME NOT NULL,
  total       DECIMAL(12, 2) NOT NULL DEFAULT 0,
  note        TEXT NULL,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id),
  INDEX orders_customer_idx (customer_id)
) ENGINE = InnoDB;

CREATE TABLE order_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NOT NULL,
  product_id  INT NOT NULL,
  quantity    INT NOT NULL,
  unit_price  DECIMAL(10, 2) NOT NULL,
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id),
  INDEX order_items_order_idx (order_id)
) ENGINE = InnoDB;

-- A recursive CTE stands in for generate_series. The default depth (1000)
-- is below the largest table.
SET SESSION cte_max_recursion_depth = 20000;

INSERT INTO customers (email, full_name, referred_by, is_active, created_at)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
SELECT CONCAT('customer', i, '@example.test'),
       CONCAT('Customer ', i),
       CASE WHEN i > 10 AND i % 7 = 0 THEN i DIV 7 END,
       i % 13 <> 0,
       TIMESTAMPADD(MINUTE, i, '2025-01-01 00:00:00')
-- InnoDB checks a foreign key row by row, so a referrer must already exist
-- when the row naming it lands; ids follow this order.
FROM n ORDER BY i;

INSERT INTO products (sku, name, price, description)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
SELECT CONCAT('SKU-', LPAD(i, 5, '0')),
       CONCAT('Product ', i),
       ROUND(5 + (i % 50) * 3.25, 2),
       CASE WHEN i % 4 = 0 THEN NULL ELSE CONCAT('Description of product ', i) END
FROM n;

INSERT INTO orders (customer_id, placed_at, total, note)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
SELECT 1 + (i % 2000),
       TIMESTAMPADD(HOUR, i, '2025-02-01 00:00:00'),
       ROUND((i % 97) * 4.5, 2),
       CASE WHEN i % 10 = 0 THEN 'gift' END
FROM n;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15000)
SELECT 1 + (i % 5000),
       1 + (i % 200),
       1 + (i % 5),
       ROUND(5 + (i % 50) * 3.25, 2)
FROM n;

ANALYZE TABLE customers, products, orders, order_items;

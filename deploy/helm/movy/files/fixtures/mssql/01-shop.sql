-- Lab source for SQL Server: the same shop as docker/fixtures/postgres.
--
-- SQL Server has no init directory, so docker/fixtures/mssql/init.sh runs this
-- on every `compose up`. Hence the guards: it must be a no-op the second time.

IF DB_ID('movy_src') IS NULL CREATE DATABASE movy_src;
GO
IF DB_ID('movy_dst') IS NULL CREATE DATABASE movy_dst;
GO

USE movy_src;
GO

IF OBJECT_ID('dbo.customers') IS NULL
BEGIN
  CREATE TABLE dbo.customers (
    id          INT IDENTITY(1, 1) PRIMARY KEY,
    email       NVARCHAR(255) NOT NULL UNIQUE,
    full_name   NVARCHAR(120) NOT NULL,
    referred_by INT NULL REFERENCES dbo.customers (id),
    is_active   BIT NOT NULL DEFAULT 1,
    created_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE TABLE dbo.products (
    id          INT IDENTITY(1, 1) PRIMARY KEY,
    sku         NVARCHAR(32) NOT NULL UNIQUE,
    name        NVARCHAR(200) NOT NULL,
    price       DECIMAL(10, 2) NOT NULL,
    description NVARCHAR(MAX) NULL
  );

  CREATE TABLE dbo.orders (
    id          INT IDENTITY(1, 1) PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES dbo.customers (id),
    placed_at   DATETIME2 NOT NULL,
    total       DECIMAL(12, 2) NOT NULL DEFAULT 0,
    note        NVARCHAR(MAX) NULL
  );
  CREATE INDEX orders_customer_idx ON dbo.orders (customer_id);

  CREATE TABLE dbo.order_items (
    id          INT IDENTITY(1, 1) PRIMARY KEY,
    order_id    INT NOT NULL REFERENCES dbo.orders (id),
    product_id  INT NOT NULL REFERENCES dbo.products (id),
    quantity    INT NOT NULL,
    unit_price  DECIMAL(10, 2) NOT NULL
  );
  CREATE INDEX order_items_order_idx ON dbo.order_items (order_id);
END
GO

-- Seeded only while empty, so a re-run of init.sh never doubles the rows.
-- A numbers table built from sys.all_objects stands in for generate_series.
IF NOT EXISTS (SELECT 1 FROM dbo.customers)
BEGIN
  WITH n AS (
    SELECT TOP (15000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
  )
  SELECT i INTO #n FROM n;

  INSERT INTO dbo.customers (email, full_name, referred_by, is_active, created_at)
  SELECT CONCAT('customer', i, '@example.test'),
         CONCAT('Customer ', i),
         CASE WHEN i > 10 AND i % 7 = 0 THEN i / 7 END,
         CASE WHEN i % 13 <> 0 THEN 1 ELSE 0 END,
         DATEADD(MINUTE, i, '2025-01-01')
  FROM #n WHERE i <= 2000 ORDER BY i;

  INSERT INTO dbo.products (sku, name, price, description)
  SELECT CONCAT('SKU-', RIGHT(CONCAT('00000', i), 5)),
         CONCAT('Product ', i),
         ROUND(5 + (i % 50) * 3.25, 2),
         CASE WHEN i % 4 = 0 THEN NULL ELSE CONCAT('Description of product ', i) END
  FROM #n WHERE i <= 200 ORDER BY i;

  INSERT INTO dbo.orders (customer_id, placed_at, total, note)
  SELECT 1 + (i % 2000),
         DATEADD(HOUR, i, '2025-02-01'),
         ROUND((i % 97) * 4.5, 2),
         CASE WHEN i % 10 = 0 THEN 'gift' END
  FROM #n WHERE i <= 5000 ORDER BY i;

  INSERT INTO dbo.order_items (order_id, product_id, quantity, unit_price)
  SELECT 1 + (i % 5000),
         1 + (i % 200),
         1 + (i % 5),
         ROUND(5 + (i % 50) * 3.25, 2)
  FROM #n ORDER BY i;

  DROP TABLE #n;
END
GO

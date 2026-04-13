#!/usr/bin/env node

/**
 * setup-test-db.js — Create a test PostgreSQL database with 20 tables and random data.
 *
 * Usage:
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=movy_test DB_USER=postgres DB_PASSWORD=secret \
 *     node scripts/setup-test-db.js
 *
 * All env vars have defaults that point to a local dev database.
 *
 * Each table gets a random row count between 100 000 and 1 000 000.
 * Data is inserted via COPY FROM STDIN for maximum throughput.
 */

'use strict';

const { Client } = require('pg');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const copyFrom = require('pg-copy-streams').from;
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const cfg = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbname:   process.env.DB_NAME     || 'movy_test',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const rng = {
  int:    (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  float:  (min, max) => (Math.random() * (max - min) + min).toFixed(4),
  bool:   ()         => Math.random() < 0.5,
  uuid:   ()         => crypto.randomUUID(),
  word:   (prefix)   => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
  email:  (i)        => `user_${i}_${Math.random().toString(36).slice(2, 6)}@example.com`,
  phone:  ()         => `+1${rng.int(2000000000, 9999999999)}`,
  date:   ()         => {
    const d = new Date(Date.now() - rng.int(0, 3 * 365 * 24 * 3600 * 1000));
    return d.toISOString().replace('T', ' ').slice(0, 19);
  },
  name:   ()         => `${FIRST_NAMES[rng.int(0, FIRST_NAMES.length - 1)]} ${LAST_NAMES[rng.int(0, LAST_NAMES.length - 1)]}`,
  text:   (words)    => Array.from({ length: words }, () => WORDS[rng.int(0, WORDS.length - 1)]).join(' '),
  status: (list)     => list[rng.int(0, list.length - 1)],
  ip:     ()         => `${rng.int(1,254)}.${rng.int(0,255)}.${rng.int(0,255)}.${rng.int(1,254)}`,
  semver: ()         => `${rng.int(0,5)}.${rng.int(0,20)}.${rng.int(0,100)}`,
  hex:    (len)      => crypto.randomBytes(len).toString('hex'),
};

const FIRST_NAMES = ['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Hank','Iris','Jake','Karen','Leo','Mia','Noah','Olivia','Pete','Quinn','Ruth','Sam','Tara'];
const LAST_NAMES  = ['Smith','Jones','Williams','Brown','Davis','Miller','Wilson','Moore','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark'];
const WORDS       = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu'];

// ─── Table definitions ────────────────────────────────────────────────────────
// Each entry: { name, ddl, rowCount, generate(i) → string[] (CSV row values) }

const TABLES = [

  // 1. users (12 columns)
  {
    name: 'users',
    ddl: `CREATE TABLE users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         VARCHAR(255) NOT NULL UNIQUE,
      full_name     VARCHAR(200),
      phone         VARCHAR(30),
      birth_date    DATE,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      role          VARCHAR(50) NOT NULL DEFAULT 'member',
      avatar_url    TEXT,
      bio           TEXT,
      last_login_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,email,full_name,phone,birth_date,is_active,role,avatar_url,bio,last_login_at,created_at,updated_at',
    generate: (i) => {
      const ts = rng.date();
      return [
        rng.uuid(),
        rng.email(i),
        rng.name(),
        rng.phone(),
        rng.date().slice(0, 10),
        rng.bool(),
        rng.status(['member','admin','moderator','viewer']),
        `https://avatars.example.com/${rng.hex(8)}.jpg`,
        rng.text(rng.int(5, 20)),
        ts,
        ts,
        ts,
      ];
    },
  },

  // 2. products (15 columns)
  {
    name: 'products',
    ddl: `CREATE TABLE products (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sku           VARCHAR(100) NOT NULL UNIQUE,
      name          VARCHAR(300) NOT NULL,
      description   TEXT,
      category_id   INT,
      brand         VARCHAR(150),
      price         NUMERIC(12,2) NOT NULL,
      cost_price    NUMERIC(12,2),
      weight_kg     NUMERIC(8,3),
      stock_qty     INT NOT NULL DEFAULT 0,
      is_published  BOOLEAN NOT NULL DEFAULT FALSE,
      rating_avg    NUMERIC(3,2),
      tags          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,sku,name,description,category_id,brand,price,cost_price,weight_kg,stock_qty,is_published,rating_avg,tags,created_at,updated_at',
    generate: (i) => {
      const ts = rng.date();
      const price = rng.float(0.99, 999.99);
      return [
        rng.uuid(),
        `SKU-${String(i).padStart(8,'0')}`,
        `Product ${rng.word('item')} ${i}`,
        rng.text(rng.int(10, 40)),
        rng.int(1, 50),
        rng.word('brand'),
        price,
        (price * 0.6).toFixed(2),
        rng.float(0.1, 25),
        rng.int(0, 10000),
        rng.bool(),
        rng.float(1, 5),
        rng.text(rng.int(2, 5)),
        ts,
        ts,
      ];
    },
  },

  // 3. customers (10 columns)
  {
    name: 'customers',
    ddl: `CREATE TABLE customers (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID,
      company_name   VARCHAR(255),
      tax_id         VARCHAR(50),
      credit_limit   NUMERIC(14,2) NOT NULL DEFAULT 0,
      loyalty_points INT NOT NULL DEFAULT 0,
      tier           VARCHAR(30) NOT NULL DEFAULT 'standard',
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,user_id,company_name,tax_id,credit_limit,loyalty_points,tier,notes,created_at,updated_at',
    generate: (_i) => {
      const ts = rng.date();
      return [
        rng.uuid(),
        rng.uuid(),
        rng.bool() ? `${rng.word('Corp')} Ltd` : '',
        rng.bool() ? rng.hex(5).toUpperCase() : '',
        rng.float(0, 50000),
        rng.int(0, 100000),
        rng.status(['standard','silver','gold','platinum']),
        rng.bool() ? rng.text(rng.int(5, 15)) : '',
        ts,
        ts,
      ];
    },
  },

  // 4. orders (13 columns)
  {
    name: 'orders',
    ddl: `CREATE TABLE orders (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
      shipping_cost   NUMERIC(10,2) NOT NULL DEFAULT 0,
      total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency        CHAR(3) NOT NULL DEFAULT 'USD',
      shipping_method VARCHAR(80),
      tracking_number VARCHAR(120),
      notes           TEXT,
      ordered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,customer_id,status,subtotal,tax_amount,shipping_cost,total_amount,currency,shipping_method,tracking_number,notes,ordered_at,updated_at',
    generate: (_i) => {
      const ts = rng.date();
      const sub  = parseFloat(rng.float(5, 5000));
      const tax  = parseFloat((sub * 0.08).toFixed(2));
      const ship = parseFloat(rng.float(0, 50));
      return [
        rng.uuid(),
        rng.uuid(),
        rng.status(['pending','confirmed','processing','shipped','delivered','cancelled','refunded']),
        sub.toFixed(2),
        tax.toFixed(2),
        ship.toFixed(2),
        (sub + tax + ship).toFixed(2),
        rng.status(['USD','EUR','GBP','CAD']),
        rng.status(['standard','express','overnight','economy']),
        rng.bool() ? rng.hex(10).toUpperCase() : '',
        rng.bool() ? rng.text(rng.int(3, 10)) : '',
        ts,
        ts,
      ];
    },
  },

  // 5. order_items (9 columns)
  {
    name: 'order_items',
    ddl: `CREATE TABLE order_items (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id    UUID NOT NULL,
      product_id  UUID NOT NULL,
      sku         VARCHAR(100),
      quantity    INT NOT NULL DEFAULT 1,
      unit_price  NUMERIC(12,2) NOT NULL,
      discount    NUMERIC(5,2) NOT NULL DEFAULT 0,
      line_total  NUMERIC(14,2) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,order_id,product_id,sku,quantity,unit_price,discount,line_total,created_at',
    generate: (_i) => {
      const qty  = rng.int(1, 10);
      const price = parseFloat(rng.float(0.99, 999.99));
      const disc  = parseFloat(rng.float(0, 30));
      return [
        rng.uuid(),
        rng.uuid(),
        rng.uuid(),
        `SKU-${rng.int(10000000, 99999999)}`,
        qty,
        price.toFixed(2),
        disc.toFixed(2),
        (qty * price * (1 - disc / 100)).toFixed(2),
        rng.date(),
      ];
    },
  },

  // 6. addresses (14 columns)
  {
    name: 'addresses',
    ddl: `CREATE TABLE addresses (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id     UUID NOT NULL,
      owner_type   VARCHAR(50) NOT NULL DEFAULT 'customer',
      label        VARCHAR(80),
      line1        VARCHAR(255) NOT NULL,
      line2        VARCHAR(255),
      city         VARCHAR(100) NOT NULL,
      state        VARCHAR(100),
      postal_code  VARCHAR(20),
      country      CHAR(2) NOT NULL DEFAULT 'US',
      is_default   BOOLEAN NOT NULL DEFAULT FALSE,
      latitude     NUMERIC(10,7),
      longitude    NUMERIC(10,7),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,owner_id,owner_type,label,line1,line2,city,state,postal_code,country,is_default,latitude,longitude,created_at',
    generate: (_i) => [
      rng.uuid(),
      rng.uuid(),
      rng.status(['customer','employee','warehouse']),
      rng.status(['home','work','billing','shipping','']),
      `${rng.int(1,9999)} ${rng.word('Street')} Ave`,
      rng.bool() ? `Suite ${rng.int(1,999)}` : '',
      rng.word('City'),
      rng.word('State'),
      `${rng.int(10000,99999)}`,
      rng.status(['US','CA','GB','AU','DE']),
      rng.bool(),
      rng.float(-90, 90),
      rng.float(-180, 180),
      rng.date(),
    ],
  },

  // 7. categories (7 columns)
  {
    name: 'categories',
    ddl: `CREATE TABLE categories (
      id          SERIAL PRIMARY KEY,
      parent_id   INT REFERENCES categories(id),
      name        VARCHAR(200) NOT NULL,
      slug        VARCHAR(200) NOT NULL UNIQUE,
      description TEXT,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'name,slug,description,sort_order,created_at',
    generate: (i) => [
      `Category ${rng.word('cat')} ${i}`,
      `category-${i}-${Math.random().toString(36).slice(2, 8)}`,
      rng.bool() ? rng.text(rng.int(5, 20)) : '',
      rng.int(0, 100),
      rng.date(),
    ],
    maxRows: 500, // categories stay small
  },

  // 8. inventory (10 columns)
  {
    name: 'inventory',
    ddl: `CREATE TABLE inventory (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id      UUID NOT NULL,
      warehouse_code  VARCHAR(50) NOT NULL,
      quantity_on_hand INT NOT NULL DEFAULT 0,
      quantity_reserved INT NOT NULL DEFAULT 0,
      quantity_available INT NOT NULL DEFAULT 0,
      reorder_point   INT NOT NULL DEFAULT 10,
      reorder_qty     INT NOT NULL DEFAULT 50,
      last_counted_at TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,product_id,warehouse_code,quantity_on_hand,quantity_reserved,quantity_available,reorder_point,reorder_qty,last_counted_at,updated_at',
    generate: (_i) => {
      const onHand   = rng.int(0, 5000);
      const reserved = rng.int(0, onHand);
      return [
        rng.uuid(),
        rng.uuid(),
        `WH-${rng.status(['EAST','WEST','NORTH','SOUTH','CENTRAL'])}-${rng.int(1,10)}`,
        onHand,
        reserved,
        onHand - reserved,
        rng.int(5, 100),
        rng.int(10, 500),
        rng.bool() ? rng.date() : '',
        rng.date(),
      ];
    },
  },

  // 9. payments (12 columns)
  {
    name: 'payments',
    ddl: `CREATE TABLE payments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id        UUID NOT NULL,
      gateway         VARCHAR(80) NOT NULL,
      gateway_tx_id   VARCHAR(255),
      method          VARCHAR(50) NOT NULL,
      amount          NUMERIC(14,2) NOT NULL,
      currency        CHAR(3) NOT NULL DEFAULT 'USD',
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      failure_reason  TEXT,
      refunded_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      paid_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,order_id,gateway,gateway_tx_id,method,amount,currency,status,failure_reason,refunded_amount,paid_at,created_at',
    generate: (_i) => {
      const ts     = rng.date();
      const status = rng.status(['pending','succeeded','failed','refunded','disputed']);
      return [
        rng.uuid(),
        rng.uuid(),
        rng.status(['stripe','paypal','braintree','square','adyen']),
        `txn_${rng.hex(12)}`,
        rng.status(['card','bank_transfer','paypal','crypto','bnpl']),
        rng.float(1, 9999),
        rng.status(['USD','EUR','GBP','CAD']),
        status,
        status === 'failed' ? rng.text(rng.int(3, 8)) : '',
        status === 'refunded' ? rng.float(0, 500) : '0.00',
        status === 'succeeded' ? ts : '',
        ts,
      ];
    },
  },

  // 10. reviews (11 columns)
  {
    name: 'reviews',
    ddl: `CREATE TABLE reviews (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id  UUID NOT NULL,
      user_id     UUID NOT NULL,
      rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title       VARCHAR(300),
      body        TEXT,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      helpful_count INT NOT NULL DEFAULT 0,
      status      VARCHAR(40) NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,product_id,user_id,rating,title,body,is_verified,helpful_count,status,created_at,updated_at',
    generate: (_i) => {
      const ts = rng.date();
      return [
        rng.uuid(),
        rng.uuid(),
        rng.uuid(),
        rng.int(1, 5),
        rng.bool() ? rng.text(rng.int(3, 8)) : '',
        rng.bool() ? rng.text(rng.int(10, 60)) : '',
        rng.bool(),
        rng.int(0, 500),
        rng.status(['pending','approved','rejected','hidden']),
        ts,
        ts,
      ];
    },
  },

  // 11. employees (14 columns)
  {
    name: 'employees',
    ddl: `CREATE TABLE employees (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_code VARCHAR(20) NOT NULL UNIQUE,
      full_name     VARCHAR(200) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      department    VARCHAR(100),
      job_title     VARCHAR(150),
      manager_id    UUID,
      hire_date     DATE NOT NULL,
      salary        NUMERIC(12,2),
      currency      CHAR(3) NOT NULL DEFAULT 'USD',
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      phone         VARCHAR(30),
      location      VARCHAR(100),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,employee_code,full_name,email,department,job_title,manager_id,hire_date,salary,currency,is_active,phone,location,created_at',
    generate: (i) => [
      rng.uuid(),
      `EMP-${String(i).padStart(7,'0')}`,
      rng.name(),
      rng.email(i),
      rng.status(['Engineering','Marketing','Sales','Finance','HR','Operations','Legal','Design']),
      rng.status(['Engineer','Manager','Director','Analyst','Specialist','Coordinator','Lead','VP']),
      rng.bool() ? rng.uuid() : '',
      rng.date().slice(0, 10),
      rng.float(30000, 300000),
      rng.status(['USD','EUR','GBP','CAD']),
      rng.bool(),
      rng.phone(),
      rng.word('city'),
      rng.date(),
    ],
  },

  // 12. departments (6 columns)
  {
    name: 'departments',
    ddl: `CREATE TABLE departments (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(150) NOT NULL UNIQUE,
      code        VARCHAR(20) NOT NULL UNIQUE,
      parent_id   INT,
      head_id     UUID,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'name,code,head_id,created_at',
    generate: (i) => [
      `Department ${rng.word('dept')} ${i}`,
      `DEPT-${String(i).padStart(4,'0')}`,
      rng.uuid(),
      rng.date(),
    ],
    maxRows: 200,
  },

  // 13. projects (13 columns)
  {
    name: 'projects',
    ddl: `CREATE TABLE projects (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code         VARCHAR(50) NOT NULL UNIQUE,
      name         VARCHAR(300) NOT NULL,
      description  TEXT,
      status       VARCHAR(50) NOT NULL DEFAULT 'draft',
      priority     SMALLINT NOT NULL DEFAULT 3,
      owner_id     UUID,
      budget       NUMERIC(14,2),
      spent        NUMERIC(14,2) NOT NULL DEFAULT 0,
      start_date   DATE,
      end_date     DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,code,name,description,status,priority,owner_id,budget,spent,start_date,end_date,created_at,updated_at',
    generate: (i) => {
      const ts = rng.date();
      const budget = parseFloat(rng.float(5000, 2000000));
      return [
        rng.uuid(),
        `PROJ-${String(i).padStart(6,'0')}`,
        `Project ${rng.word('proj')} ${i}`,
        rng.bool() ? rng.text(rng.int(10, 40)) : '',
        rng.status(['draft','active','on_hold','completed','cancelled']),
        rng.int(1, 5),
        rng.uuid(),
        budget.toFixed(2),
        (budget * rng.float(0, 1)).toFixed(2),
        rng.date().slice(0, 10),
        rng.date().slice(0, 10),
        ts,
        ts,
      ];
    },
  },

  // 14. tasks (14 columns)
  {
    name: 'tasks',
    ddl: `CREATE TABLE tasks (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id   UUID,
      parent_id    UUID,
      title        VARCHAR(500) NOT NULL,
      description  TEXT,
      status       VARCHAR(50) NOT NULL DEFAULT 'todo',
      priority     SMALLINT NOT NULL DEFAULT 3,
      assignee_id  UUID,
      reporter_id  UUID,
      due_date     DATE,
      estimate_hrs NUMERIC(6,2),
      logged_hrs   NUMERIC(6,2) NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,project_id,parent_id,title,description,status,priority,assignee_id,reporter_id,due_date,estimate_hrs,logged_hrs,created_at,updated_at',
    generate: (_i) => {
      const ts = rng.date();
      return [
        rng.uuid(),
        rng.uuid(),
        rng.bool() ? rng.uuid() : '',
        rng.text(rng.int(3, 10)),
        rng.bool() ? rng.text(rng.int(10, 40)) : '',
        rng.status(['todo','in_progress','review','done','blocked','cancelled']),
        rng.int(1, 5),
        rng.uuid(),
        rng.uuid(),
        rng.bool() ? rng.date().slice(0, 10) : '',
        rng.float(0.5, 40),
        rng.float(0, 40),
        ts,
        ts,
      ];
    },
  },

  // 15. event_logs (8 columns)
  {
    name: 'event_logs',
    ddl: `CREATE TABLE event_logs (
      id          BIGSERIAL PRIMARY KEY,
      entity_type VARCHAR(80) NOT NULL,
      entity_id   UUID,
      event       VARCHAR(120) NOT NULL,
      actor_id    UUID,
      actor_type  VARCHAR(50),
      payload     TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'entity_type,entity_id,event,actor_id,actor_type,payload,occurred_at',
    generate: (_i) => [
      rng.status(['user','order','product','payment','review','task']),
      rng.uuid(),
      rng.status(['created','updated','deleted','viewed','exported','imported','approved','rejected']),
      rng.uuid(),
      rng.status(['user','system','api','webhook']),
      rng.bool() ? `{"key":"${rng.word('val')}"}` : '',
      rng.date(),
    ],
  },

  // 16. sessions (9 columns)
  {
    name: 'sessions',
    ddl: `CREATE TABLE sessions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL,
      token_hash   VARCHAR(128) NOT NULL UNIQUE,
      ip_address   INET,
      user_agent   TEXT,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,user_id,token_hash,ip_address,user_agent,is_active,last_seen_at,expires_at,created_at',
    generate: (_i) => {
      const ts      = rng.date();
      const expires = new Date(Date.now() + rng.int(1, 30) * 86400000).toISOString().replace('T',' ').slice(0,19);
      return [
        rng.uuid(),
        rng.uuid(),
        rng.hex(64),
        rng.ip(),
        `Mozilla/5.0 (${rng.status(['Windows NT 10.0','Macintosh','X11; Linux x86_64'])}) ${rng.word('agent')}/${rng.semver()}`,
        rng.bool(),
        ts,
        expires,
        ts,
      ];
    },
  },

  // 17. notifications (10 columns)
  {
    name: 'notifications',
    ddl: `CREATE TABLE notifications (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL,
      channel     VARCHAR(40) NOT NULL DEFAULT 'in_app',
      type        VARCHAR(100) NOT NULL,
      title       VARCHAR(300),
      body        TEXT,
      data        TEXT,
      is_read     BOOLEAN NOT NULL DEFAULT FALSE,
      read_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,user_id,channel,type,title,body,data,is_read,read_at,created_at',
    generate: (_i) => {
      const isRead = rng.bool();
      const ts     = rng.date();
      return [
        rng.uuid(),
        rng.uuid(),
        rng.status(['in_app','email','sms','push']),
        rng.status(['order_status','payment_received','review_reply','task_assigned','mention','system_alert']),
        rng.text(rng.int(3, 8)),
        rng.bool() ? rng.text(rng.int(10, 30)) : '',
        rng.bool() ? `{"ref":"${rng.uuid()}"}` : '',
        isRead,
        isRead ? ts : '',
        ts,
      ];
    },
  },

  // 18. tags (5 columns)
  {
    name: 'tags',
    ddl: `CREATE TABLE tags (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL UNIQUE,
      slug        VARCHAR(100) NOT NULL UNIQUE,
      color       CHAR(7),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'name,slug,color,created_at',
    generate: (i) => [
      `tag-${i}-${Math.random().toString(36).slice(2, 8)}`,
      `tag-${i}-${Math.random().toString(36).slice(2, 8)}`,
      `#${rng.hex(3).toUpperCase().padEnd(6,'0')}`,
      rng.date(),
    ],
    maxRows: 2000,
  },

  // 19. media_assets (13 columns)
  {
    name: 'media_assets',
    ddl: `CREATE TABLE media_assets (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id     UUID NOT NULL,
      owner_type   VARCHAR(60) NOT NULL DEFAULT 'product',
      bucket       VARCHAR(80) NOT NULL,
      key          TEXT NOT NULL,
      original_name VARCHAR(300),
      mime_type    VARCHAR(120),
      size_bytes   BIGINT,
      width_px     INT,
      height_px    INT,
      alt_text     VARCHAR(300),
      is_public    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    copyColumns: 'id,owner_id,owner_type,bucket,key,original_name,mime_type,size_bytes,width_px,height_px,alt_text,is_public,created_at',
    generate: (_i) => {
      const ext  = rng.status(['jpg','png','webp','avif','svg','mp4','pdf']);
      const name = `${rng.word('file')}.${ext}`;
      const isImage = ['jpg','png','webp','avif','svg'].includes(ext);
      return [
        rng.uuid(),
        rng.uuid(),
        rng.status(['product','user','review','project','task']),
        rng.status(['assets','uploads','media','cdn']),
        `${rng.date().slice(0,7).replace(' ','-')}/${rng.hex(8)}/${name}`,
        name,
        `image/${ext}`,
        rng.int(1024, 50 * 1024 * 1024),
        isImage ? rng.int(64, 4096) : '',
        isImage ? rng.int(64, 4096) : '',
        rng.bool() ? rng.text(rng.int(3, 8)) : '',
        rng.bool(),
        rng.date(),
      ];
    },
  },

  // 20. audit_trail (11 columns)
  {
    name: 'audit_trail',
    ddl: `CREATE TABLE audit_trail (
      id           BIGSERIAL PRIMARY KEY,
      table_name   VARCHAR(80) NOT NULL,
      record_id    UUID,
      operation    CHAR(6) NOT NULL,
      changed_by   UUID,
      changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      old_values   TEXT,
      new_values   TEXT,
      ip_address   INET,
      user_agent   TEXT,
      request_id   UUID
    )`,
    copyColumns: 'table_name,record_id,operation,changed_by,changed_at,old_values,new_values,ip_address,user_agent,request_id',
    generate: (_i) => [
      rng.status(['users','products','orders','payments','reviews','tasks','inventory']),
      rng.uuid(),
      rng.status(['INSERT','UPDATE','DELETE']),
      rng.uuid(),
      rng.date(),
      rng.bool() ? `{"field":"${rng.word('old')}"}` : '',
      rng.bool() ? `{"field":"${rng.word('new')}"}` : '',
      rng.ip(),
      `Mozilla/5.0 ${rng.word('agent')}`,
      rng.uuid(),
    ],
  },
];

// ─── COPY writer ──────────────────────────────────────────────────────────────

/**
 * Escape a single field for CSV / PostgreSQL COPY text format.
 * Rules: wrap in quotes if needed, escape inner quotes and backslashes.
 */
function escapeCopyField(v) {
  if (v === null || v === undefined || v === '') return '\\N'; // NULL
  const s = String(v);
  // Use \N for empty string explicitly — if you want empty string not NULL,
  // change this. For seeding purposes we treat '' as NULL.
  if (s === '') return '\\N';
  // Escape backslash and newlines, quote if contains tab/newline/backslash
  const escaped = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return escaped;
}

function rowToCopyLine(fields) {
  return fields.map(escapeCopyField).join('\t') + '\n';
}

// ─── Core seeding ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 5_000; // rows per push into the COPY stream

async function seedTable(client, table, targetRows) {
  const start = Date.now();
  process.stdout.write(`  Seeding ${table.name} (${targetRows.toLocaleString()} rows) … `);

  const copyStream = client.query(copyFrom(`COPY ${table.name} (${table.copyColumns}) FROM STDIN`));

  const readable = new PassThrough();
  const writeDone = pipeline(readable, copyStream);

  let written = 0;
  while (written < targetRows) {
    const chunk = Math.min(BATCH_SIZE, targetRows - written);
    let data = '';
    for (let j = 0; j < chunk; j++) {
      data += rowToCopyLine(table.generate(written + j + 1));
    }
    readable.push(data);
    written += chunk;
  }
  readable.push(null); // signal EOF

  await writeDone;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`done (${elapsed}s)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function createDatabase(cfg) {
  const admin = new Client({
    host: cfg.host, port: cfg.port,
    user: cfg.user, password: cfg.password,
    database: 'postgres',
  });
  await admin.connect();
  const exists = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`, [cfg.dbname]
  );
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${cfg.dbname}"`);
    console.log(`  Created database "${cfg.dbname}".`);
  } else {
    console.log(`  Database "${cfg.dbname}" already exists — reusing.`);
  }
  await admin.end();
}

async function main() {
  console.log('\n=== Movy test database setup ===');
  console.log(`Target: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.dbname}\n`);

  // Step 1 — ensure DB exists
  console.log('1. Creating database …');
  await createDatabase(cfg);

  // Step 2 — connect to the new DB and create schema
  const client = new Client({
    host: cfg.host, port: cfg.port,
    user: cfg.user, password: cfg.password,
    database: cfg.dbname,
  });
  await client.connect();

  try {
    // Enable pgcrypto for gen_random_uuid() (available in most Postgres installs)
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    console.log('\n2. Creating tables …');
    for (const table of TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${table.name} CASCADE`);
      await client.query(table.ddl);
      console.log(`  ✓ ${table.name}`);
    }

    // Step 3 — seed data
    console.log('\n3. Inserting data …');
    const grandStart = Date.now();
    let totalRows = 0;

    for (const table of TABLES) {
      const maxRows    = table.maxRows ?? 1_000_000;
      const minRows    = table.maxRows ? Math.min(100, table.maxRows) : 100_000;
      const targetRows = rng.int(minRows, maxRows);
      await seedTable(client, table, targetRows);
      totalRows += targetRows;
    }

    const totalSecs = ((Date.now() - grandStart) / 1000).toFixed(1);
    console.log(`\n=== Done! ===`);
    console.log(`Inserted ~${totalRows.toLocaleString()} total rows across ${TABLES.length} tables in ${totalSecs}s.`);
    console.log(`\nConnection string:\n  postgresql://${cfg.user}:****@${cfg.host}:${cfg.port}/${cfg.dbname}\n`);

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

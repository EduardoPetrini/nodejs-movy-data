#!/usr/bin/env node

/**
 * Seed script: inserts 100 000 rows into public."AdminUser"
 *
 * Usage:
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=mydb DB_USER=postgres DB_PASSWORD=secret \
 *     node scripts/seed-admin-users.js
 *
 * All env vars have defaults that point to a local dev database.
 */

const { Pool } = require('pg');
const crypto = require('crypto');

const TOTAL_ROWS = 1_000_000;
const BATCH_SIZE = 10_000;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function uuid() {
  return crypto.randomUUID();
}

/** Cheap deterministic-looking password hash (not bcrypt — seeding only). */
function fakeHash(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function buildBatch(offset, size) {
  const now = new Date();
  const rows = [];
  for (let i = 0; i < size; i++) {
    const index = offset + i + 1;
    rows.push({
      id: uuid(),
      email: `user_${index}_${uuid().slice(0, 8)}@example.com`,
      password: fakeHash(`password_${index}`),
      name: `User ${index}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  return rows;
}

async function insertBatch(client, rows) {
  const values = [];
  const placeholders = rows.map((row, i) => {
    const base = i * 6;
    values.push(row.id, row.email, row.password, row.name, row.createdAt, row.updatedAt);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  const sql = `
    INSERT INTO public."AdminUser" (id, email, "password", "name", "createdAt", "updatedAt")
    VALUES ${placeholders.join(', ')}
    ON CONFLICT DO NOTHING
  `;

  await client.query(sql, values);
}

async function main() {
  console.log(`Seeding ${TOTAL_ROWS.toLocaleString()} rows into public."AdminUser" …`);
  const start = Date.now();

  const client = await pool.connect();
  try {
    let inserted = 0;
    const batches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      const offset = b * BATCH_SIZE;
      const size = Math.min(BATCH_SIZE, TOTAL_ROWS - offset);
      const rows = buildBatch(offset, size);
      await insertBatch(client, rows);
      inserted += size;

      if ((b + 1) % 10 === 0 || b === batches - 1) {
        const pct = ((inserted / TOTAL_ROWS) * 100).toFixed(1);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  ${inserted.toLocaleString()} / ${TOTAL_ROWS.toLocaleString()} rows (${pct}%) — ${elapsed}s elapsed`);
      }
    }

    const total = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`\nDone. Inserted ${inserted.toLocaleString()} rows in ${total}s.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

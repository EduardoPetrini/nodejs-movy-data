# Integration Tests

Integration tests require two live PostgreSQL instances. Use Docker Compose to spin them up.

## Setup

```bash
# Start source and destination Postgres containers
docker run -d --name movy-source -p 5432:5432 -e POSTGRES_PASSWORD=pass postgres:15
docker run -d --name movy-dest   -p 5433:5433 -e POSTGRES_PASSWORD=pass -e PGPORT=5433 postgres:15

# Seed the source database
psql -h 127.0.0.1 -p 5432 -U postgres -c "
  CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, created_at TIMESTAMP DEFAULT now());
  CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount NUMERIC(10,2));
  INSERT INTO users (email) SELECT 'user' || i || '@example.com' FROM generate_series(1, 100) AS i;
  INSERT INTO orders (user_id, amount) SELECT (random()*99+1)::int, (random()*1000)::numeric FROM generate_series(1, 500);
"
```

## Run

```bash
# Full migration (interactive)
npm start

# Or set env vars to skip password prompts
PGPASSWORD=pass DEST_PGPASSWORD=pass npm start
```

## Verify

```bash
# Row counts should match
psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -c "SELECT COUNT(*) FROM users;"
psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -c "SELECT COUNT(*) FROM orders;"
```

## Test Cases

1. **Full migration** — all tables, constraints, indexes, sequences migrate correctly
2. **Idempotent re-run** — running twice should succeed (TRUNCATE + re-copy)
3. **Unsupported type** — select `mysql` in CLI, verify rejection with version roadmap message
4. **Partial failure** — create a table with a conflict on dest before migration, verify other tables succeed and failure is reported

## Cleanup

```bash
docker rm -f movy-source movy-dest
```

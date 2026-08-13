-- Runs once, on first boot of the disposable Postgres in
-- docker-compose.test.yml. POSTGRES_DB already created babellm_test for the
-- vitest suite; this adds the database that `pnpm dev:test-db` serves browser
-- checks from, so the suite's TRUNCATEs and a browser session stay out of
-- each other's way.
CREATE DATABASE babellm_dev OWNER babellm;

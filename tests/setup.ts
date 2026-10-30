// lib/db builds a postgres client from DATABASE_URL at module load. postgres.js
// connects lazily, so a dummy URL is enough to import the modules under test.
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db";

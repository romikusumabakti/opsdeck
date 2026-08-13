/**
 * Take the single row a write was supposed to produce.
 *
 * `INSERT ... RETURNING` always yields a row, but Drizzle types the result as
 * an array, so under `noUncheckedIndexedAccess` every `const [created] = await
 * db.insert(...).returning()` is a `T | undefined` the caller has to answer
 * for. Answering it with `!` throws the same unhelpful
 * `Cannot read properties of undefined (reading 'id')` the code already threw;
 * this throws something a log reader can act on instead.
 *
 * Use it ONLY where a row is genuinely guaranteed — inserts, and updates whose
 * target was already proven to exist. An `UPDATE`/`DELETE ... RETURNING` that
 * may legitimately match nothing should keep destructuring and check for
 * undefined, so "not found" stays a normal result rather than an exception.
 */
export function one<T>(rows: T[], entity: string): T {
  const [row] = rows;
  if (!row) {
    throw new Error(
      `Expected ${entity} to be returned by the write, got no rows`
    );
  }
  return row;
}

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "node:fs";

export const VECTOR_DB_MISSING_HINT =
  "data/embeddings.db not found — run 'npm run seed' first";

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function open(path) {
  if (!path) throw new TypeError("open(path) requires a database path");
  if (!existsSync(path)) {
    throw new Error(VECTOR_DB_MISSING_HINT);
  }
  const db = new Database(path, { readonly: true });
  sqliteVec.load(db);

  function searchByVector(queryVec, { k = 15, filterIds } = {}) {
    if (!(queryVec instanceof Float32Array)) {
      throw new TypeError("searchByVector(queryVec) requires a Float32Array");
    }
    const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
    const filterSet = filterIds instanceof Set ? filterIds : filterIds ? new Set(filterIds) : null;

    const rows = db
      .prepare(
        `SELECT m.id AS id, vec_distance_cosine(v.embedding, ?) AS distance
         FROM fragments_vec v
         JOIN fragments_meta m ON m.rowid = v.rowid
         ORDER BY distance ASC`,
      )
      .all(buf);

    const out = [];
    for (const row of rows) {
      if (filterSet && !filterSet.has(row.id)) continue;
      out.push({ id: row.id, score: clamp01(1 - row.distance), distance: row.distance });
      if (out.length >= k) break;
    }
    return out;
  }

  function close() {
    db.close();
  }

  return { searchByVector, close, _db: db };
}

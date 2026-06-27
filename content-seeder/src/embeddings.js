import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { embed, getEmbeddingModel } from "@aemdisc/shared";

function openDb(path) {
  const db = new Database(path);
  sqliteVec.load(db);
  return db;
}

function resetSchema(db, dims) {
  db.exec(`DROP TABLE IF EXISTS fragments_vec;`);
  db.exec(`DROP TABLE IF EXISTS fragments_meta;`);
  db.exec(
    `CREATE VIRTUAL TABLE fragments_vec USING vec0(embedding float[${dims}]);`,
  );
  db.exec(
    `CREATE TABLE fragments_meta (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      locale TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL
    );`,
  );
}

export async function buildEmbeddingsDb({ path, fragments, embedImpl = embed }) {
  if (fragments.length === 0) throw new Error("buildEmbeddingsDb: fragments array is empty");
  await mkdir(dirname(path), { recursive: true });
  const startedAt = Date.now();

  // Detect embedding dimensions from the first fragment.
  const firstVector = await embedImpl(fragments[0].content);
  if (!(firstVector instanceof Float32Array)) {
    throw new Error(`Embedding for ${fragments[0].id} is not a Float32Array (got ${typeof firstVector})`);
  }
  const dims = firstVector.length;

  const db = openDb(path);
  try {
    resetSchema(db, dims);
    const insertVec = db.prepare(
      `INSERT INTO fragments_vec(rowid, embedding) VALUES (?, ?)`,
    );
    const insertMeta = db.prepare(
      `INSERT INTO fragments_meta(rowid, id, locale, category, title) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAll = db.transaction((rows) => {
      for (const row of rows) {
        // sqlite-vec virtual tables require a true integer rowid; BigInt is the
        // safest way to force better-sqlite3 to bind it as an INTEGER.
        const rowid = BigInt(row.rowid);
        insertVec.run(rowid, Buffer.from(row.vector.buffer));
        insertMeta.run(rowid, row.id, row.locale, row.category, row.title);
      }
    });

    // First fragment already embedded above; embed the rest.
    const rows = [{ rowid: 1, vector: firstVector, id: fragments[0].id, locale: fragments[0].locale, category: fragments[0].category, title: fragments[0].title }];
    for (let i = 1; i < fragments.length; i += 1) {
      const f = fragments[i];
      const vector = await embedImpl(f.content);
      if (!(vector instanceof Float32Array)) {
        throw new Error(`Embedding for ${f.id} is not a Float32Array (got ${typeof vector})`);
      }
      if (vector.length !== dims) {
        throw new Error(
          `Embedding dimension mismatch for ${f.id}: expected ${dims} (from ${fragments[0].id}), got ${vector.length}`,
        );
      }
      rows.push({ rowid: i + 1, vector, id: f.id, locale: f.locale, category: f.category, title: f.title });
    }
    insertAll(rows);
    const durationMs = Date.now() - startedAt;
    return { count: rows.length, durationMs, embeddingModel: getEmbeddingModel(), dims };
  } finally {
    db.close();
  }
}

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { embed, EMBED_MODEL } from "@aemdisc/shared";

const EMBED_DIMS = 768;

function openDb(path) {
  const db = new Database(path);
  sqliteVec.load(db);
  return db;
}

function resetSchema(db) {
  db.exec(`DROP TABLE IF EXISTS fragments_vec;`);
  db.exec(`DROP TABLE IF EXISTS fragments_meta;`);
  db.exec(
    `CREATE VIRTUAL TABLE fragments_vec USING vec0(embedding float[${EMBED_DIMS}]);`,
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
  await mkdir(dirname(path), { recursive: true });
  const startedAt = Date.now();
  const db = openDb(path);
  try {
    resetSchema(db);
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

    const rows = [];
    for (let i = 0; i < fragments.length; i += 1) {
      const f = fragments[i];
      const vector = await embedImpl(f.content);
      if (!(vector instanceof Float32Array)) {
        throw new Error(
          `Embedding for ${f.id} is not a Float32Array (got ${typeof vector})`,
        );
      }
      if (vector.length !== EMBED_DIMS) {
        throw new Error(
          `Embedding for ${f.id} has ${vector.length} dims, expected ${EMBED_DIMS}`,
        );
      }
      rows.push({
        rowid: i + 1,
        vector,
        id: f.id,
        locale: f.locale,
        category: f.category,
        title: f.title,
      });
    }
    insertAll(rows);
    const durationMs = Date.now() - startedAt;
    return { count: rows.length, durationMs, embeddingModel: EMBED_MODEL };
  } finally {
    db.close();
  }
}

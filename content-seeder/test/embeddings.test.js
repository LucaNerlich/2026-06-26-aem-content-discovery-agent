import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { buildEmbeddingsDb } from "../src/embeddings.js";

function fixedVector(seed) {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i += 1) v[i] = ((seed + i) % 100) / 100;
  return v;
}

const sampleFragments = [
  { id: "frag_001", locale: "en-gb", category: "product-story", title: "A", content: "alpha" },
  { id: "frag_002", locale: "fr-fr", category: "care-guide", title: "B", content: "beta" },
];

test("buildEmbeddingsDb writes both tables with the expected row count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-test-"));
  const path = join(dir, "embeddings.db");
  try {
    const fakeEmbed = async (text) => fixedVector(text.length);
    const res = await buildEmbeddingsDb({ path, fragments: sampleFragments, embedImpl: fakeEmbed });
    assert.equal(res.count, 2);
    assert.equal(res.dims, 768, "detected dims must equal fixedVector size");
    assert.equal(typeof res.embeddingModel, "string", "embeddingModel must be a string");

    const db = new Database(path);
    sqliteVec.load(db);
    try {
      const metaCount = db.prepare("select count(*) as n from fragments_meta").get();
      assert.deepEqual(metaCount, { n: 2 });
      const vecCount = db.prepare("select count(*) as n from fragments_vec").get();
      assert.deepEqual(vecCount, { n: 2 });
      const meta = db.prepare("select id, locale, category, title from fragments_meta order by rowid").all();
      assert.equal(meta[0].id, "frag_001");
      assert.equal(meta[1].locale, "fr-fr");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEmbeddingsDb rejects inconsistent embedding dimensions across fragments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-test-"));
  const path = join(dir, "embeddings.db");
  try {
    // First fragment returns 384 dims, second returns 512 — mismatch must be caught.
    let call = 0;
    const inconsistentEmbed = async () => new Float32Array(call++ === 0 ? 384 : 512);
    await assert.rejects(
      () => buildEmbeddingsDb({ path, fragments: sampleFragments, embedImpl: inconsistentEmbed }),
      /dimension mismatch/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEmbeddingsDb is idempotent — second run drops & recreates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-test-"));
  const path = join(dir, "embeddings.db");
  try {
    const fakeEmbed = async () => fixedVector(1);
    await buildEmbeddingsDb({ path, fragments: sampleFragments, embedImpl: fakeEmbed });
    const res2 = await buildEmbeddingsDb({ path, fragments: sampleFragments.slice(0, 1), embedImpl: fakeEmbed });
    assert.equal(res2.count, 1);
    const db = new Database(path);
    sqliteVec.load(db);
    try {
      assert.deepEqual(db.prepare("select count(*) as n from fragments_meta").get(), { n: 1 });
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

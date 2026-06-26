import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { buildBm25Index } from "../src/retrieve/bm25.js";
import { openVectorStore, VECTOR_DB_MISSING_HINT } from "../src/retrieve/index.js";
import { JsonFragmentSource, AemFragmentSource } from "../src/sources/index.js";

const EMBED_DIMS = 768;

function unitVector(seed) {
  const v = new Float32Array(EMBED_DIMS);
  for (let i = 0; i < EMBED_DIMS; i += 1) v[i] = Math.sin(seed + i * 0.013);
  let mag = 0;
  for (let i = 0; i < EMBED_DIMS; i += 1) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < EMBED_DIMS; i += 1) v[i] /= mag;
  return v;
}

async function buildFixtureDb(path, fragments, vectorFor) {
  const db = new Database(path);
  sqliteVec.load(db);
  try {
    db.exec(`CREATE VIRTUAL TABLE fragments_vec USING vec0(embedding float[${EMBED_DIMS}]);`);
    db.exec(`CREATE TABLE fragments_meta (rowid INTEGER PRIMARY KEY, id TEXT, locale TEXT, category TEXT, title TEXT);`);
    const insertVec = db.prepare("INSERT INTO fragments_vec(rowid, embedding) VALUES (?, ?)");
    const insertMeta = db.prepare("INSERT INTO fragments_meta(rowid, id, locale, category, title) VALUES (?, ?, ?, ?, ?)");
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const rowid = BigInt(r.rowid);
        insertVec.run(rowid, Buffer.from(r.vector.buffer));
        insertMeta.run(rowid, r.id, r.locale, r.category, r.title);
      }
    });
    tx(fragments.map((f, i) => ({ rowid: i + 1, vector: vectorFor(f), ...f })));
  } finally {
    db.close();
  }
}

test("openVectorStore throws documented error when DB is missing", () => {
  assert.throws(
    () => openVectorStore("/tmp/definitely-does-not-exist-9999.db"),
    (err) => err.message === VECTOR_DB_MISSING_HINT,
  );
});

test("vectorStore.searchByVector returns cosine-based scores in 0..1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vec-test-"));
  const dbPath = join(dir, "embeddings.db");
  const frags = [
    { id: "a", locale: "en-gb", category: "product-story", title: "A" },
    { id: "b", locale: "en-gb", category: "care-guide", title: "B" },
    { id: "c", locale: "fr-fr", category: "product-story", title: "C" },
  ];
  try {
    await buildFixtureDb(dbPath, frags, (f) => unitVector(f.id.charCodeAt(0)));
    const store = openVectorStore(dbPath);
    try {
      const r = store.searchByVector(unitVector("a".charCodeAt(0)), { k: 2 });
      assert.equal(r.length, 2);
      for (const hit of r) {
        assert.ok(hit.score >= 0 && hit.score <= 1, `score in 0..1, got ${hit.score}`);
      }
      assert.equal(r[0].id, "a");
      const filtered = store.searchByVector(unitVector(0), { k: 5, filterIds: new Set(["b"]) });
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, "b");
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBm25Index returns hits with filterIds applied", () => {
  const idx = buildBm25Index([
    { id: "f1", title: "Recycled wool winter coats", content: "sustainable insulation", targetAudience: "" },
    { id: "f2", title: "Sneaker care guide", content: "cleaning leather", targetAudience: "" },
    { id: "f3", title: "Organic cotton tees", content: "breathable summer fabric", targetAudience: "" },
  ]);
  const all = idx.searchByText("recycled wool");
  assert.equal(all[0].id, "f1");
  const filtered = idx.searchByText("recycled wool", { filterIds: new Set(["f2", "f3"]) });
  assert.equal(filtered.length, 0);
});

test("buildBm25Index handles small corpus and unknown queries", () => {
  const empty = buildBm25Index([]);
  assert.deepEqual(empty.searchByText("anything"), []);
  const tiny = buildBm25Index([{ id: "x", title: "alpha", content: "beta", targetAudience: "" }]);
  assert.deepEqual(tiny.searchByText("alpha"), [], "below consolidation threshold yields no hits");
  const idx = buildBm25Index([
    { id: "a", title: "alpha one", content: "", targetAudience: "" },
    { id: "b", title: "alpha two", content: "", targetAudience: "" },
    { id: "c", title: "alpha three", content: "", targetAudience: "" },
  ]);
  assert.deepEqual(idx.searchByText("zzznotpresent"), []);
});

test("JsonFragmentSource loads a Corpus and returns fragments[]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "src-test-"));
  const path = join(dir, "corpus.json");
  const corpus = {
    schemaVersion: "1.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    model: "m",
    embeddingModel: "e",
    fragments: [
      {
        id: "f1",
        title: "T",
        category: "product-story",
        targetAudience: "audience",
        brandGuidelinesApplied: ["premium-tone"],
        locale: "en-gb",
        lastModified: "2026-01-01T00:00:00.000Z",
        content: "body",
      },
    ],
  };
  try {
    await writeFile(path, JSON.stringify(corpus), "utf8");
    const src = new JsonFragmentSource(path);
    const { fragments } = await src.load();
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].id, "f1");
    assert.equal(src.kind, "json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AemFragmentSource exposes kind='aem' and wraps listFragments", async () => {
  const client = { get: async () => ({ entities: [] }) };
  const src = new AemFragmentSource(client, { rootPath: "/content/dam/aemcontentdisc", locales: ["en-gb"] });
  assert.equal(src.kind, "aem");
  const { fragments } = await src.load();
  assert.deepEqual(fragments, []);
});

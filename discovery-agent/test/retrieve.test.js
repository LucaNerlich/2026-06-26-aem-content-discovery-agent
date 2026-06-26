import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { retrieve } from "../src/pipeline/retrieve.js";
import { JsonFragmentSource, AemFragmentSource, VECTOR_DB_MISSING_HINT } from "@aemdisc/shared";

const EMBED_DIMS = 768;

function vectorFromTopic(topic) {
  const v = new Float32Array(EMBED_DIMS);
  let h = 0;
  for (let i = 0; i < topic.length; i += 1) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
  for (let i = 0; i < EMBED_DIMS; i += 1) v[i] = Math.sin(h + i * 0.013);
  let m = 0;
  for (let i = 0; i < EMBED_DIMS; i += 1) m += v[i] * v[i];
  m = Math.sqrt(m) || 1;
  for (let i = 0; i < EMBED_DIMS; i += 1) v[i] /= m;
  return v;
}

const FIXTURE_FRAGMENTS = [
  { id: "f_wool", title: "Recycled wool winter coats", category: "product-story", targetAudience: "women uk", brandGuidelinesApplied: ["premium-tone", "sustainability-voice"], locale: "en-gb", lastModified: "2026-04-01T00:00:00.000Z", content: "Recycled wool insulation sustainable winter outerwear collection." },
  { id: "f_knit", title: "Sustainable knitwear merino", category: "product-story", targetAudience: "women uk", brandGuidelinesApplied: ["premium-tone"], locale: "en-gb", lastModified: "2025-11-01T00:00:00.000Z", content: "Merino wool knitwear natural fibres ethically sourced." },
  { id: "f_care", title: "Care guide for wool garments", category: "care-guide", targetAudience: "all", brandGuidelinesApplied: ["sustainability-voice"], locale: "en-gb", lastModified: "2023-01-01T00:00:00.000Z", content: "Wash wool garments cold cycle dry flat care instructions." },
  { id: "f_us", title: "Holiday styling tips", category: "seasonal-campaign", targetAudience: "us", brandGuidelinesApplied: ["premium-tone"], locale: "en-gb", lastModified: "2026-05-01T00:00:00.000Z", content: "Festive layering looks tips styling." },
  { id: "f_fr", title: "Manteaux laine recyclée", category: "product-story", targetAudience: "fr", brandGuidelinesApplied: ["premium-tone"], locale: "fr-fr", lastModified: "2026-03-01T00:00:00.000Z", content: "Manteaux d'hiver laine recyclée durable." },
  { id: "f_de", title: "Winterjacken Wolle", category: "product-story", targetAudience: "de", brandGuidelinesApplied: ["premium-tone"], locale: "de-de", lastModified: "2026-03-01T00:00:00.000Z", content: "Winterjacken aus recycelter Wolle." },
];

async function buildFixtureDb(path, fragments) {
  const db = new Database(path);
  sqliteVec.load(db);
  try {
    db.exec(`CREATE VIRTUAL TABLE fragments_vec USING vec0(embedding float[${EMBED_DIMS}]);`);
    db.exec(`CREATE TABLE fragments_meta (rowid INTEGER PRIMARY KEY, id TEXT, locale TEXT, category TEXT, title TEXT);`);
    const iv = db.prepare("INSERT INTO fragments_vec(rowid, embedding) VALUES (?, ?)");
    const im = db.prepare("INSERT INTO fragments_meta(rowid, id, locale, category, title) VALUES (?, ?, ?, ?, ?)");
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const rowid = BigInt(r.rowid);
        iv.run(rowid, Buffer.from(r.vector.buffer));
        im.run(rowid, r.id, r.locale, r.category, r.title);
      }
    });
    tx(fragments.map((f, i) => ({ rowid: i + 1, vector: vectorFromTopic(f.title), ...f })));
  } finally {
    db.close();
  }
}

async function setupFixture() {
  const dir = await mkdtemp(join(tmpdir(), "retrieve-test-"));
  const corpusPath = join(dir, "corpus.json");
  const dbPath = join(dir, "embeddings.db");
  await writeFile(corpusPath, JSON.stringify({
    schemaVersion: "1.0",
    generatedAt: "2026-06-01T00:00:00.000Z",
    model: "m",
    embeddingModel: "e",
    fragments: FIXTURE_FRAGMENTS,
  }), "utf8");
  await buildFixtureDb(dbPath, FIXTURE_FRAGMENTS);
  return { dir, corpusPath, dbPath };
}

function mockEmbed() {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    return vectorFromTopic(text);
  };
  fn.calls = calls;
  return fn;
}

const baseBrief = {
  audience: "women uk",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["premium-tone"],
  requiredTopics: ["recycled wool coats", "merino knitwear", "wool care"],
  pathHint: "/en-gb/winter",
};

test("retrieve returns default k=3 matches with scores in 0..1 and reasons ≤140 chars", async () => {
  const fx = await setupFixture();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    const embedImpl = mockEmbed();
    const result = await retrieve(baseBrief, { source, vectorDbPath: fx.dbPath, embedImpl });
    assert.equal(result.matches.length, 3);
    assert.equal(result.vectorSearchAvailable, true);
    assert.equal(result.localeRelaxed, false);
    for (const m of result.matches) {
      assert.ok(m.score >= 0 && m.score <= 1, `score range ${m.score}`);
      assert.ok(m.reason.length <= 140, `reason length ${m.reason.length}`);
      assert.ok(m.fragment && m.fragment.id);
      assert.ok(m.breakdown.cosine >= 0 && m.breakdown.cosine <= 1);
    }
    assert.equal(embedImpl.calls.length, baseBrief.requiredTopics.length, "one embed call per topic");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("retrieve respects custom k and populates nearMisses", async () => {
  const fx = await setupFixture();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    const result = await retrieve(baseBrief, { source, vectorDbPath: fx.dbPath, embedImpl: mockEmbed(), k: 2 });
    assert.equal(result.matches.length, 2);
    assert.ok(result.nearMisses.length >= 1, "nearMisses populated");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("locale ladder relaxes to prefix when exact locale absent", async () => {
  const fx = await setupFixture();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    const brief = { ...baseBrief, locale: "en-us", brandGuidelines: [] };
    const result = await retrieve(brief, { source, vectorDbPath: fx.dbPath, embedImpl: mockEmbed() });
    assert.equal(result.localeRelaxed, "prefix");
    for (const m of result.matches) assert.ok(m.fragment.locale.startsWith("en-"));
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("locale ladder relaxes to any when nothing matches prefix", async () => {
  const fx = await setupFixture();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    const brief = { ...baseBrief, locale: "es-es", brandGuidelines: [] };
    const result = await retrieve(brief, { source, vectorDbPath: fx.dbPath, embedImpl: mockEmbed() });
    assert.equal(result.localeRelaxed, "any");
    assert.ok(result.matches.length > 0);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("brand filter drops fragments and populates droppedByBrandFilter", async () => {
  const fx = await setupFixture();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    const brief = { ...baseBrief, brandGuidelines: ["sustainability-voice"] };
    const result = await retrieve(brief, { source, vectorDbPath: fx.dbPath, embedImpl: mockEmbed() });
    assert.ok(result.droppedByBrandFilter.length > 0, "expected some drops");
    for (const d of result.droppedByBrandFilter) {
      assert.ok(!(d.fragment.brandGuidelinesApplied ?? []).includes("sustainability-voice"));
    }
    for (const m of result.matches) {
      assert.ok((m.fragment.brandGuidelinesApplied ?? []).includes("sustainability-voice"));
    }
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("missing embeddings DB throws documented error before any embed call", async () => {
  const fx = await setupFixture();
  await rm(fx.dbPath, { force: true });
  const embedImpl = mockEmbed();
  try {
    const source = new JsonFragmentSource(fx.corpusPath);
    await assert.rejects(
      () => retrieve(baseBrief, { source, vectorDbPath: fx.dbPath, embedImpl }),
      (err) => err.message === VECTOR_DB_MISSING_HINT,
    );
    assert.equal(embedImpl.calls.length, 0, "no embed calls before DB check");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("AemFragmentSource path skips vector search and sets vectorSearchAvailable=false", async () => {
  const fx = await setupFixture();
  try {
    const client = {
      get: async (path) => {
        if (path.endsWith("/en-gb.json")) {
          return { entities: FIXTURE_FRAGMENTS.filter((f) => f.locale === "en-gb").map((f) => ({ class: ["assets/asset"], properties: { name: f.id } })) };
        }
        const id = path.split("/").pop().replace(".json", "");
        const frag = FIXTURE_FRAGMENTS.find((f) => f.id === id);
        if (!frag) return { entities: [] };
        return {
          properties: {
            elements: Object.fromEntries(Object.entries(frag).map(([k, v]) => [k, { value: v }])),
          },
        };
      },
    };
    const source = new AemFragmentSource(client, { rootPath: "/content/dam/aemcontentdisc", locales: ["en-gb"] });
    const embedImpl = mockEmbed();
    const result = await retrieve(baseBrief, { source, vectorDbPath: fx.dbPath, embedImpl });
    assert.equal(result.vectorSearchAvailable, false);
    assert.equal(embedImpl.calls.length, 0, "no embed calls in AEM/BM25-only path");
    assert.ok(result.matches.length > 0);
    for (const m of result.matches) assert.equal(m.breakdown.cosine, 0);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

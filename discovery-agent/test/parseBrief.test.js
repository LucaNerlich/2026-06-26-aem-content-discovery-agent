import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LlmJsonParseError,
  LlmTimeoutError,
} from "@aemdisc/shared";
import { parseBrief } from "../src/pipeline/parseBrief.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "parseBrief-test-"));
  process.env.PROMPT_LOG_PATH = join(tmpDir, "prompt-log.md");
});

afterEach(async () => {
  delete process.env.PROMPT_LOG_PATH;
  await rm(tmpDir, { recursive: true, force: true });
});

const VALID = {
  audience: "Eco-conscious women aged 25-40, UK market.",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["sustainability-voice", "premium-tone"],
  requiredTopics: ["recycled materials", "care instructions", "winter styling"],
  pathHint: "/en-gb/collections/winter-sustainable",
};

const BRIEF_TEXT =
  "Landing page for sustainable winter collection. Audience: eco-conscious women 25-40 in the UK. Tone: premium. Path: /en-gb/collections/winter-sustainable.";

function makeChat(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async ({ system, user, json }) => {
    calls.push({ system, user, json });
    if (queue.length === 0) throw new Error("chat mock exhausted");
    const next = queue.shift();
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

test("parseBrief: happy path returns valid StructuredBrief", async () => {
  const chat = makeChat([VALID]);
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.audience, VALID.audience);
  assert.equal(result.locale, "en-gb");
  assert.deepEqual(result.brandGuidelines, VALID.brandGuidelines);
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0].json, true);
});

test("parseBrief: preserves theme when the model returns one", async () => {
  const chat = makeChat([{ ...VALID, theme: "sustainable winter collection" }]);
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.theme, "sustainable winter collection");
});

test("parseBrief: defaults theme to empty string when the model omits it", async () => {
  const chat = makeChat([VALID]); // VALID has no theme field
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.theme, "", "theme should default to '' so retrieval can fall back cleanly");
});

test("parseBrief: locale forced from URL path overrides model locale", async () => {
  const chat = makeChat([{ ...VALID, locale: "fr-fr" }]);
  const result = await parseBrief(
    "Landing page at /en-gb/collections/winter for UK audience.",
    { chat },
  );
  assert.equal(result.locale, "en-gb");
  assert.ok(result.uncertain && result.uncertain.length === 1);
  assert.match(result.uncertain[0], /URL\/path indicated "en-gb"/);
});

test("parseBrief: unknown locale from model defaults to en-gb and notes uncertain", async () => {
  const chat = makeChat([{ ...VALID, locale: "es-es" }]);
  const result = await parseBrief(
    "Audience: general European shoppers. No URL specified.",
    { chat },
  );
  assert.equal(result.locale, "en-gb");
  assert.ok(result.uncertain && result.uncertain.length === 1);
  assert.match(result.uncertain[0], /defaulted to "en-gb"/);
});

test("parseBrief: retries once on ZodError (bad shape) then succeeds", async () => {
  const badShape = { ...VALID };
  delete badShape.audience;
  const chat = makeChat([badShape, VALID]);
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.audience, VALID.audience);
  assert.equal(chat.calls.length, 2);
  assert.match(chat.calls[1].system, /previous attempt failed validation/);
});

test("parseBrief: retries once on LlmJsonParseError then succeeds", async () => {
  const jsonErr = new LlmJsonParseError("not valid JSON", {
    model: "gemma4:26b",
    responseHead: "not json {",
  });
  const chat = makeChat([jsonErr, VALID]);
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.audience, VALID.audience);
  assert.equal(chat.calls.length, 2);
});

test("parseBrief: succeeds on second retry after two bad-shape attempts", async () => {
  const badShape = { ...VALID };
  delete badShape.audience;
  const chat = makeChat([badShape, badShape, VALID]);
  const result = await parseBrief(BRIEF_TEXT, { chat });
  assert.equal(result.audience, VALID.audience);
  assert.equal(chat.calls.length, 3);
  assert.match(chat.calls[2].system, /Return ONLY valid JSON\. No prose, no markdown fences, no comments\./);
});

test("parseBrief: hard fails after two bad-shape retries (three attempts total)", async () => {
  const badShape = { ...VALID };
  delete badShape.audience;
  const chat = makeChat([badShape, badShape, badShape]);
  await assert.rejects(
    () => parseBrief(BRIEF_TEXT, { chat }),
    (err) => err?.name === "ZodError",
  );
  assert.equal(chat.calls.length, 3);
});

test("parseBrief: non-shape errors propagate immediately without retry", async () => {
  const timeoutErr = new LlmTimeoutError("timed out", { model: "gemma4:26b" });
  const chat = makeChat([timeoutErr, VALID]);
  await assert.rejects(
    () => parseBrief(BRIEF_TEXT, { chat }),
    (err) => err instanceof LlmTimeoutError,
  );
  assert.equal(chat.calls.length, 1, "must not retry on non-shape errors");
});

test("parseBrief: rejects empty rawText", async () => {
  const chat = makeChat([VALID]);
  await assert.rejects(
    () => parseBrief("", { chat }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => parseBrief("   ", { chat }),
    (err) => err instanceof TypeError,
  );
});

test("parseBrief: system prompt mentions locked brand vocabulary", async () => {
  const chat = makeChat([VALID]);
  await parseBrief(BRIEF_TEXT, { chat });
  assert.match(chat.calls[0].system, /sustainability-voice/);
  assert.match(chat.calls[0].system, /premium-tone/);
});

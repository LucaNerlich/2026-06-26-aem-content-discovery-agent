import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCfModel, pushFragments } from "../src/aem-push.js";

function clientWithGet(getImpl) {
  return {
    get: getImpl,
    post: async () => ({}),
    put: async () => ({}),
    delete: async () => ({}),
  };
}

const MODEL_PATH = "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment";

function validModelResponse() {
  // Simulates a Sling-rendered .model.json walking dialog items with `name` properties.
  return {
    "jcr:content": {
      model: {
        "cq:dialog": {
          content: {
            items: {
              id: { name: "id" },
              title: { name: "title" },
              category: { name: "category" },
              targetAudience: { name: "targetAudience" },
              brandGuidelinesApplied: { name: "brandGuidelinesApplied" },
              locale: { name: "locale" },
              lastModified: { name: "lastModified" },
              content: { name: "content" },
            },
          },
        },
      },
    },
  };
}

test("validateCfModel passes when all expected fields exist", async () => {
  const client = clientWithGet(async () => validModelResponse());
  const res = await validateCfModel({ client, modelPath: MODEL_PATH });
  assert.ok(res.fields.includes("title"));
});

test("validateCfModel throws with a field-diff when a field is missing", async () => {
  const incomplete = validModelResponse();
  delete incomplete["jcr:content"].model["cq:dialog"].content.items.targetAudience;
  delete incomplete["jcr:content"].model["cq:dialog"].content.items.lastModified;
  const client = clientWithGet(async () => incomplete);
  await assert.rejects(
    () => validateCfModel({ client, modelPath: MODEL_PATH }),
    (err) => {
      assert.match(err.message, /missing required fields/);
      assert.match(err.message, /targetAudience/);
      assert.match(err.message, /lastModified/);
      return true;
    },
  );
});

test("validateCfModel wraps fetch errors with the model path", async () => {
  const client = clientWithGet(async () => {
    throw new Error("not found");
  });
  await assert.rejects(
    () => validateCfModel({ client, modelPath: MODEL_PATH }),
    /AEM model not reachable at \/conf/,
  );
});

test("pushFragments reports per-fragment success and failure", async () => {
  let calls = 0;
  const client = {
    post: async () => {
      calls += 1;
      if (calls === 2) throw new Error("AEM kaboom");
      return {};
    },
    put: async () => ({}),
    delete: async () => ({}),
    get: async () => ({}),
  };
  const fragments = [
    { id: "frag_001", locale: "en-gb", title: "A", category: "product-story", targetAudience: "x", brandGuidelinesApplied: ["premium-tone"], lastModified: "2026-01-01T00:00:00.000Z", content: "body" },
    { id: "frag_002", locale: "en-gb", title: "B", category: "product-story", targetAudience: "x", brandGuidelinesApplied: ["premium-tone"], lastModified: "2026-01-01T00:00:00.000Z", content: "body" },
    { id: "frag_003", locale: "fr-fr", title: "C", category: "product-story", targetAudience: "x", brandGuidelinesApplied: ["premium-tone"], lastModified: "2026-01-01T00:00:00.000Z", content: "body" },
  ];
  const res = await pushFragments({ client, modelPath: MODEL_PATH, fragments });
  assert.equal(res.attempted, 3);
  assert.equal(res.succeeded, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.failures[0].id, "frag_002");
});

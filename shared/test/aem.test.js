import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AemAuthError,
  AemNotFoundError,
  AemUnavailableError,
  createAemClient,
  createOrUpdateFragment,
  damPathToAssetsApi,
  deleteFragmentTree,
  fragmentToElements,
  getCfModel,
  listFragments,
} from "../src/aem/index.js";

function createMockFetch(handler) {
  const calls = [];
  const mockFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
    });
    const result = await handler({ url, init, callIndex: calls.length - 1 });
    const status = result?.status ?? 200;
    const body =
      result?.body === undefined ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...(result?.headers ?? {}) },
    });
  };
  mockFetch.calls = calls;
  return mockFetch;
}

const validFragment = {
  id: "frag_001",
  title: "Recycled Wool Story",
  category: "product-story",
  targetAudience: "Eco-conscious women aged 25-40, UK market.",
  brandGuidelinesApplied: ["sustainability-voice", "premium-tone"],
  locale: "en-gb",
  lastModified: "2026-04-12T09:30:00Z",
  content: "Body text long enough to be useful.",
};

test("damPathToAssetsApi maps /content/dam paths to /api/assets", () => {
  assert.equal(
    damPathToAssetsApi("/content/dam/aemcontentdisc/en-gb/frag_001"),
    "/api/assets/aemcontentdisc/en-gb/frag_001",
  );
  assert.throws(() => damPathToAssetsApi("/some/other/path"));
});

test("fragmentToElements emits Assets API element shape (array, calendar)", () => {
  const elements = fragmentToElements(validFragment);
  assert.deepEqual(elements.brandGuidelinesApplied, {
    value: ["sustainability-voice", "premium-tone"],
  });
  assert.deepEqual(elements.lastModified, {
    value: "2026-04-12T09:30:00Z",
    type: "calendar",
  });
  assert.equal(elements.id.value, "frag_001");
  assert.equal(elements.locale.value, "en-gb");
});

test("createAemClient injects Basic auth header on every request", async () => {
  const fetch = createMockFetch(async () => ({ status: 200, body: { ok: true } }));
  const client = createAemClient({
    baseUrl: "http://aem.test",
    username: "admin",
    password: "admin",
    fetch,
  });
  await client.get("/foo.json");
  const expected = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
  const auth = new Headers(fetch.calls[0].headers).get("Authorization");
  assert.equal(auth, expected);
});

test("createAemClient normalises 401 to AemAuthError", async () => {
  const fetch = createMockFetch(async () => ({ status: 401, body: { error: "no" } }));
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  await assert.rejects(() => client.get("/foo"), (err) => err instanceof AemAuthError);
});

test("createAemClient normalises 404 to AemNotFoundError", async () => {
  const fetch = createMockFetch(async () => ({ status: 404, body: {} }));
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  await assert.rejects(() => client.get("/missing"), (err) => err instanceof AemNotFoundError);
});

test("createAemClient normalises network failure to AemUnavailableError", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  await assert.rejects(() => client.get("/foo"), (err) => err instanceof AemUnavailableError);
});

test("createOrUpdateFragment POSTs Assets API JSON with cq:model + elements", async () => {
  const fetch = createMockFetch(async () => ({ status: 201, body: {} }));
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  const result = await createOrUpdateFragment(client, {
    modelPath: "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment",
    parentPath: "/content/dam/aemcontentdisc/en-gb",
    fragment: validFragment,
  });
  assert.equal(result.path, "/content/dam/aemcontentdisc/en-gb/frag_001");
  assert.equal(result.operation, "created");
  const call = fetch.calls[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/api\/assets\/aemcontentdisc\/en-gb\/frag_001$/);
  const payload = JSON.parse(call.body);
  assert.equal(payload.properties["cq:model"], "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment");
  assert.deepEqual(payload.properties.elements.brandGuidelinesApplied.value, [
    "sustainability-voice",
    "premium-tone",
  ]);
  assert.equal(payload.properties.elements.lastModified.type, "calendar");
});

test("createOrUpdateFragment falls back to PUT on 409", async () => {
  const fetch = createMockFetch(async ({ callIndex }) => {
    if (callIndex === 0) return { status: 409, body: {} };
    return { status: 200, body: {} };
  });
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  const result = await createOrUpdateFragment(client, {
    modelPath: "/conf/x",
    parentPath: "/content/dam/aemcontentdisc/en-gb",
    fragment: validFragment,
  });
  assert.equal(result.operation, "updated");
  assert.equal(fetch.calls[0].method, "POST");
  assert.equal(fetch.calls[1].method, "PUT");
});

test("deleteFragmentTree treats 404 as already-gone", async () => {
  const fetch = createMockFetch(async () => ({ status: 404, body: {} }));
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  const result = await deleteFragmentTree(client, "/content/dam/aemcontentdisc/en-gb");
  assert.equal(result.deleted, false);
});

test("listFragments walks locale folders and maps elements to Fragment shape", async () => {
  const localeFolderResponse = {
    entities: [{ class: ["assets/asset"], properties: { name: "frag_001" } }],
  };
  const fragmentResponse = {
    properties: { elements: fragmentToElements(validFragment) },
  };
  const fetch = createMockFetch(async ({ url }) => {
    if (url.endsWith("/api/assets/aemcontentdisc/en-gb.json")) {
      return { status: 200, body: localeFolderResponse };
    }
    if (url.endsWith("/api/assets/aemcontentdisc/en-gb/frag_001.json")) {
      return { status: 200, body: fragmentResponse };
    }
    return { status: 404, body: {} };
  });
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  const fragments = await listFragments(client, {
    rootPath: "/content/dam/aemcontentdisc",
    locales: ["en-gb"],
  });
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].id, "frag_001");
  assert.equal(fragments[0].path, "/content/dam/aemcontentdisc/en-gb/frag_001");
  assert.deepEqual(fragments[0].brandGuidelinesApplied, [
    "sustainability-voice",
    "premium-tone",
  ]);
});

test("getCfModel fetches <modelPath>.model.json", async () => {
  const fetch = createMockFetch(async ({ url }) => {
    assert.match(url, /\/conf\/aemcontentdisc\/.+\.model\.json$/);
    return { status: 200, body: { id: "model" } };
  });
  const client = createAemClient({ baseUrl: "http://aem.test", fetch });
  const model = await getCfModel(client, "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment");
  assert.equal(model.id, "model");
});

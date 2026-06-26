import {
  createAemClient,
  createOrUpdateFragment,
  deleteFragmentTree,
  getCfModel,
} from "@aemdisc/shared";

const EXPECTED_FIELDS = [
  "id",
  "title",
  "category",
  "targetAudience",
  "brandGuidelinesApplied",
  "locale",
  "lastModified",
  "content",
];

const AEM_DAM_ROOT = "/content/dam/aemcontentdisc";

function collectFieldNames(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectFieldNames(v, out);
    return out;
  }
  if (typeof node.name === "string" && node.name.length > 0) {
    out.add(node.name);
  }
  for (const key of Object.keys(node)) {
    collectFieldNames(node[key], out);
  }
  return out;
}

export async function validateCfModel({ client, modelPath }) {
  let response;
  try {
    response = await getCfModel(client, modelPath);
  } catch (err) {
    throw new Error(
      `AEM model not reachable at ${modelPath}: ${err.message}`,
    );
  }
  const found = collectFieldNames(response);
  const missing = EXPECTED_FIELDS.filter((f) => !found.has(f));
  if (missing.length > 0) {
    const lines = [
      `AEM model at ${modelPath} is missing required fields:`,
      ...missing.map((m) => `  - ${m}`),
      `Found field names: ${[...found].sort().join(", ") || "(none)"}`,
      `Expected: ${EXPECTED_FIELDS.join(", ")}`,
    ];
    throw new Error(lines.join("\n"));
  }
  return { fields: [...found].sort() };
}

export async function resetLocales({ client, locales }) {
  const results = [];
  for (const locale of locales) {
    const damPath = `${AEM_DAM_ROOT}/${locale}`;
    const res = await deleteFragmentTree(client, damPath);
    results.push({ locale, ...res });
  }
  return results;
}

export async function pushFragments({ client, modelPath, fragments, logger }) {
  const localeSet = new Set(fragments.map((f) => f.locale));
  let succeeded = 0;
  const failures = [];
  for (const fragment of fragments) {
    const parentPath = `${AEM_DAM_ROOT}/${fragment.locale}`;
    try {
      const res = await createOrUpdateFragment(client, {
        modelPath,
        parentPath,
        fragment,
      });
      succeeded += 1;
      logger?.info?.({ id: fragment.id, op: res.operation, path: res.path }, "aem-push");
    } catch (err) {
      failures.push({ id: fragment.id, locale: fragment.locale, error: err.message });
      logger?.error?.(
        { id: fragment.id, locale: fragment.locale, errorClass: err.name, err: err.message },
        "aem-push-failed",
      );
    }
  }
  return {
    attempted: fragments.length,
    succeeded,
    failed: failures.length,
    locales: [...localeSet],
    failures,
  };
}

export function aemClient(opts) {
  return createAemClient(opts);
}

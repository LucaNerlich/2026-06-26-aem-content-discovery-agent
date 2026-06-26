import { AemConflictError, AemNotFoundError } from "./client.js";

const CONTENT_DAM_PREFIX = "/content/dam/";
const API_ASSETS_PREFIX = "/api/assets/";

export function damPathToAssetsApi(damPath) {
  if (!damPath.startsWith(CONTENT_DAM_PREFIX)) {
    throw new Error(
      `damPathToAssetsApi: expected path under /content/dam/, got: ${damPath}`,
    );
  }
  return API_ASSETS_PREFIX + damPath.slice(CONTENT_DAM_PREFIX.length);
}

export function fragmentToElements(fragment) {
  return {
    id: { value: fragment.id },
    title: { value: fragment.title },
    category: { value: fragment.category },
    targetAudience: { value: fragment.targetAudience },
    brandGuidelinesApplied: { value: fragment.brandGuidelinesApplied },
    locale: { value: fragment.locale },
    lastModified: { value: fragment.lastModified, type: "calendar" },
    content: { value: fragment.content },
  };
}

export function buildCreateFragmentBody({ modelPath, fragment }) {
  return {
    properties: {
      "cq:model": modelPath,
      title: fragment.title,
      elements: fragmentToElements(fragment),
    },
  };
}

export function buildUpdateFragmentBody({ fragment }) {
  return {
    properties: {
      title: fragment.title,
      elements: fragmentToElements(fragment),
    },
  };
}

export async function createOrUpdateFragment(
  client,
  { modelPath, parentPath, fragment },
) {
  if (!modelPath) throw new Error("createOrUpdateFragment: modelPath is required");
  if (!parentPath) throw new Error("createOrUpdateFragment: parentPath is required");
  if (!fragment?.id) throw new Error("createOrUpdateFragment: fragment.id is required");

  const damPath = `${parentPath.replace(/\/$/, "")}/${fragment.id}`;
  const apiPath = damPathToAssetsApi(damPath);
  const createBody = buildCreateFragmentBody({ modelPath, fragment });

  try {
    await client.post(apiPath, createBody, {
      headers: { "Content-Type": "application/json" },
    });
    return { path: damPath, operation: "created" };
  } catch (error) {
    if (!(error instanceof AemConflictError)) throw error;
  }

  const updateBody = buildUpdateFragmentBody({ fragment });
  await client.put(apiPath, updateBody, {
    headers: { "Content-Type": "application/json" },
  });
  return { path: damPath, operation: "updated" };
}

export async function deleteFragmentTree(client, damPath) {
  if (!damPath?.startsWith(CONTENT_DAM_PREFIX)) {
    throw new Error(`deleteFragmentTree: expected path under /content/dam/, got: ${damPath}`);
  }
  const apiPath = damPathToAssetsApi(damPath);
  try {
    await client.delete(apiPath);
    return { path: damPath, deleted: true };
  } catch (error) {
    if (error instanceof AemNotFoundError) {
      return { path: damPath, deleted: false };
    }
    throw error;
  }
}

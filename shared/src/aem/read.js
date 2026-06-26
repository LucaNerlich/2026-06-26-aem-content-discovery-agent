import { AemNotFoundError } from "./client.js";
import { damPathToAssetsApi } from "./write.js";

const ASSET_CLASS = "assets/asset";
const FOLDER_CLASS = "assets/folder";

function classList(entity) {
  if (!entity?.class) return [];
  return Array.isArray(entity.class) ? entity.class : [entity.class];
}

function isAssetEntity(entity) {
  return classList(entity).includes(ASSET_CLASS);
}

function isFolderEntity(entity) {
  return classList(entity).includes(FOLDER_CLASS);
}

function entityName(entity) {
  return entity?.properties?.name ?? null;
}

export function elementsToFragment(elements, damPath) {
  if (!elements) return null;
  const get = (k) => elements[k]?.value;
  return {
    id: get("id"),
    title: get("title"),
    category: get("category"),
    targetAudience: get("targetAudience"),
    brandGuidelinesApplied: get("brandGuidelinesApplied"),
    locale: get("locale"),
    lastModified: get("lastModified"),
    content: get("content"),
    path: damPath,
  };
}

async function listFolderEntities(client, damFolderPath) {
  const apiPath = `${damPathToAssetsApi(damFolderPath)}.json`;
  try {
    const response = await client.get(apiPath);
    return response?.entities ?? [];
  } catch (error) {
    if (error instanceof AemNotFoundError) return [];
    throw error;
  }
}

async function readFragmentAt(client, damPath) {
  const apiPath = `${damPathToAssetsApi(damPath)}.json`;
  const response = await client.get(apiPath);
  const elements = response?.properties?.elements;
  return elementsToFragment(elements, damPath);
}

export async function listFragments(
  client,
  { rootPath = "/content/dam/aemcontentdisc", locales } = {},
) {
  if (!rootPath) throw new Error("listFragments: rootPath is required");

  let localeFolders = locales;
  if (!localeFolders) {
    const entities = await listFolderEntities(client, rootPath);
    localeFolders = entities.filter(isFolderEntity).map(entityName).filter(Boolean);
  }

  const fragments = [];
  for (const locale of localeFolders) {
    const localeDamPath = `${rootPath.replace(/\/$/, "")}/${locale}`;
    const entities = await listFolderEntities(client, localeDamPath);
    for (const entity of entities) {
      if (!isAssetEntity(entity)) continue;
      const name = entityName(entity);
      if (!name) continue;
      const damPath = `${localeDamPath}/${name}`;
      const fragment = await readFragmentAt(client, damPath);
      if (fragment) fragments.push(fragment);
    }
  }
  return fragments;
}

export async function getCfModel(client, modelPath) {
  if (!modelPath) throw new Error("getCfModel: modelPath is required");
  const response = await client.get(`${modelPath}.model.json`);
  return response;
}

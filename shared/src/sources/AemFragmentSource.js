import { listFragments } from "../aem/read.js";

export class AemFragmentSource {
  constructor(client, { rootPath = "/content/dam/aemcontentdisc", locales } = {}) {
    if (!client || typeof client.get !== "function") {
      throw new TypeError("AemFragmentSource(client) requires an AEM client");
    }
    this.client = client;
    this.rootPath = rootPath;
    this.locales = locales;
    this.kind = "aem";
  }

  async load() {
    const fragments = await listFragments(this.client, {
      rootPath: this.rootPath,
      locales: this.locales,
    });
    return { fragments };
  }
}

import { readFile } from "node:fs/promises";
import { parseCorpus } from "../schema/corpus.js";

export class JsonFragmentSource {
  constructor(filePath) {
    if (!filePath || typeof filePath !== "string") {
      throw new TypeError("JsonFragmentSource(filePath) requires a non-empty string path");
    }
    this.filePath = filePath;
    this.kind = "json";
  }

  async load() {
    const raw = await readFile(this.filePath, "utf8");
    const corpus = parseCorpus(JSON.parse(raw));
    return { fragments: corpus.fragments };
  }
}

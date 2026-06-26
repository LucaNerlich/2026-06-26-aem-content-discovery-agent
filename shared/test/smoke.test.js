import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholder } from "../src/index.js";

test("shared barrel exports placeholder", () => {
  assert.equal(placeholder, true);
});

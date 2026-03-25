import { expect, test } from "@rstest/core";
import { add } from "../src/math";

test("add", () => {
  expect(add(2, 2)).toBe(4);
  expect(add(12, 12)).toBe(24);
});

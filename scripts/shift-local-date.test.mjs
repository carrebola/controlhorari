import assert from "node:assert/strict";
import test from "node:test";
import { shiftLocalDate } from "../src/lib/local-date.ts";

test("shiftLocalDate moves across month boundaries", () => {
  assert.equal(shiftLocalDate("29/10/2026", 1), "30/10/2026");
  assert.equal(shiftLocalDate("01/11/2026", -1), "31/10/2026");
  assert.equal(shiftLocalDate("31/12/2026", 1), "01/01/2027");
});

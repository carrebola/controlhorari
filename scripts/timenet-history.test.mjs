import assert from "node:assert/strict";
import test from "node:test";
import { parseTimenetHistory } from "../cloudflare/src/timenet-history.ts";

test("calendar times on a future day are never imported as punches", () => {
  const result = parseTimenetHistory({ C: [{ D: "15/10/2026", T: "15:30 a 18:30", C: [] }] });
  assert.deepEqual(result.events, []);
  assert.equal(result.days[0].entryTime, "15:30");
  assert.equal(result.days[0].exitTime, "18:30");
});

test("each real punch preserves its direction, even if an entry is missing", () => {
  const result = parseTimenetHistory({ C: [{ D: "14/10/2026", T: "15:30 a 21:00", C: [
    { I: 1, H: "16:00", T: 1 }, { I: 2, H: "17:00", T: 0 }, { I: 3, H: "21:00", T: 1 },
  ] }] });
  assert.deepEqual(result.events.map((event) => event.action), ["exit", "entry", "exit"]);
  assert.deepEqual(result.events.map((event) => event.time), ["16:00", "17:00", "21:00"]);
});

test("holidays and undefined days have no automatic schedule", () => {
  const result = parseTimenetHistory({ C: [{ D: "12/10/2026", T: "Festiu", C: [] }, { D: "16/10/2026", T: "No definit", C: [] }] });
  assert.ok(result.days.every((day) => day.entryTime === null && day.exitTime === null));
});

test("split shifts are preserved as labels without inventing one continuous shift", () => {
  const result = parseTimenetHistory({ C: [{ D: "14/10/2026", T: "08:00 a 12:00, 15:00 a 19:00", C: [] }] });
  assert.equal(result.days[0].entryTime, null);
  assert.equal(result.days[0].exitTime, null);
});

test("unexpected or incomplete responses fail before replacing saved history", () => {
  for (const payload of [{}, { C: [] }, { C: [{ D: "14/10/2026", T: "15:30 a 21:00" }] },
    { C: [{ D: "14/10/2026", T: "15:30 a 21:00", C: [{ I: 1, H: "15:00", T: 7 }] }] }]) {
    assert.throws(() => parseTimenetHistory(payload));
  }
});

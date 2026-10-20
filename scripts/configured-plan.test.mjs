import assert from "node:assert/strict";
import test from "node:test";
import { configuredPunchPlan, localClock } from "../cloudflare/src/time.ts";

const date = { year: 2026, month: 10, day: 20 };
const zone = "Europe/Madrid";
const schedule = { enabled: 1, entry_time: "09:00", exit_time: "18:00" };
const calendar = { entry_time: "08:00", exit_time: "17:00", random_entry_at: 123, random_exit_at: 456 };

test("user hours take precedence over Timenet hours and its legacy random times", () => {
  const plan = configuredPunchPlan(date, zone, schedule, 0, calendar);
  assert.equal(localClock(plan.entryAt, zone), "09:00:00");
  assert.equal(localClock(plan.exitAt, zone), "18:00:00");
});

test("both sides of the configured plus/minus margin remain possible", (t) => {
  t.mock.method(crypto, "getRandomValues", (values) => { values[0] = 0; return values; });
  const early = configuredPunchPlan(date, zone, schedule, 60, calendar);
  assert.equal(localClock(early.exitAt, zone), "17:59:00");
  t.mock.restoreAll();
  t.mock.method(crypto, "getRandomValues", (values) => { values[0] = 120; return values; });
  const late = configuredPunchPlan(date, zone, schedule, 60, calendar);
  assert.equal(localClock(late.exitAt, zone), "18:01:00");
});

test("a saved plan stays stable until user hours or margin change, independent of Timenet hours", () => {
  const plan = configuredPunchPlan(date, zone, schedule, 60, calendar);
  const cached = { ...calendar, plan_key: plan.key, random_entry_at: plan.entryAt, random_exit_at: plan.exitAt };
  assert.deepEqual(configuredPunchPlan(date, zone, schedule, 60, { ...cached, exit_time: "16:00" }), plan);
  const changed = configuredPunchPlan(date, zone, { ...schedule, exit_time: "19:00" }, 0, cached);
  assert.equal(localClock(changed.exitAt, zone), "19:00:00");
  const marginChanged = configuredPunchPlan(date, zone, schedule, 0, cached);
  assert.equal(localClock(marginChanged.exitAt, zone), "18:00:00");
});

test("disabled user days and Timenet nonworking days have no automatic plan", () => {
  assert.equal(configuredPunchPlan(date, zone, { ...schedule, enabled: 0 }, 60, calendar), null);
  assert.equal(configuredPunchPlan(date, zone, undefined, 60, calendar), null);
  assert.equal(configuredPunchPlan(date, zone, schedule, 60, { ...calendar, entry_time: null, exit_time: null }), null);
  assert.ok(configuredPunchPlan(date, zone, schedule, 60, null));
});

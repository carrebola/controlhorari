import assert from "node:assert/strict";
import test from "node:test";
import { configuredPunchPlan, ENTRY_LEAD_SECONDS, EXIT_LAG_SECONDS, localClock } from "../cloudflare/src/time.ts";

const date = { year: 2026, month: 10, day: 20 };
const nextMonth = { year: 2026, month: 11, day: 3 };
const zone = "Europe/Madrid";
const schedule = { enabled: 1, entry_time: "09:00", exit_time: "18:00" };
const calendar = { entry_time: "11:30", exit_time: "21:00", random_entry_at: null, random_exit_at: null, plan_key: null };

test("without a saved plan, Timenet previsto seeds entry -10 min and exit +10 min", () => {
  const plan = configuredPunchPlan(date, zone, schedule, 0, calendar);
  assert.equal(localClock(plan.entryAt, zone), "11:20:00");
  assert.equal(localClock(plan.exitAt, zone), "21:10:00");
  assert.equal(ENTRY_LEAD_SECONDS, 600);
  assert.equal(EXIT_LAG_SECONDS, 600);
});

test("weekly schedule is only a fallback before Timenet calendar exists", () => {
  const plan = configuredPunchPlan(date, zone, schedule, 0, null);
  assert.equal(localClock(plan.entryAt, zone), "08:50:00");
  assert.equal(localClock(plan.exitAt, zone), "18:10:00");
});

test("a saved monthly plan is kept even if Timenet previsto changes later", () => {
  const created = configuredPunchPlan(date, zone, schedule, 60, calendar);
  const saved = {
    entry_time: "15:00",
    exit_time: "22:00",
    plan_key: created.key,
    random_entry_at: created.entryAt,
    random_exit_at: created.exitAt,
  };
  const reused = configuredPunchPlan(date, zone, schedule, 60, saved);
  assert.equal(reused.entryAt, created.entryAt);
  assert.equal(reused.exitAt, created.exitAt);
  assert.equal(reused.key, created.key);
});

test("a new month recalculates randoms from the current Timenet previsto", () => {
  const october = configuredPunchPlan(date, zone, schedule, 0, calendar);
  const november = configuredPunchPlan(nextMonth, zone, schedule, 0, {
    entry_time: "11:30",
    exit_time: "21:00",
    plan_key: october.key,
    random_entry_at: october.entryAt,
    random_exit_at: october.exitAt,
  });
  assert.notEqual(november.key, october.key);
  assert.equal(localClock(november.entryAt, zone), "11:20:00");
  assert.equal(localClock(november.exitAt, zone), "21:10:00");
});

test("changing the random margin invalidates the saved monthly plan", () => {
  const created = configuredPunchPlan(date, zone, schedule, 60, calendar);
  const changed = configuredPunchPlan(date, zone, schedule, 0, {
    ...calendar,
    plan_key: created.key,
    random_entry_at: created.entryAt,
    random_exit_at: created.exitAt,
  });
  assert.notEqual(changed.key, created.key);
  assert.equal(localClock(changed.entryAt, zone), "11:20:00");
});

test("disabled user days and Timenet nonworking days have no automatic plan", () => {
  assert.equal(configuredPunchPlan(date, zone, { ...schedule, enabled: 0 }, 60, calendar), null);
  assert.equal(configuredPunchPlan(date, zone, undefined, 60, calendar), null);
  assert.equal(configuredPunchPlan(date, zone, schedule, 60, { ...calendar, entry_time: null, exit_time: null }), null);
  assert.ok(configuredPunchPlan(date, zone, schedule, 60, null));
});

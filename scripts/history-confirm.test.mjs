import assert from "node:assert/strict";
import test from "node:test";
import { historyConfirmsPunch } from "../cloudflare/src/timenet-history.ts";
import { claimUncertainJob } from "../cloudflare/src/uncertain-sync.ts";

test("historyConfirmsPunch finds today's action and ignores the other direction", () => {
  const events = [
    { remoteId: "1", localDate: "29/10/2026", action: "exit", time: "18:41" },
    { remoteId: "2", localDate: "29/10/2026", action: "entry", time: "15:20" },
    { remoteId: "3", localDate: "28/10/2026", action: "entry", time: "15:20" },
  ];
  assert.deepEqual(historyConfirmsPunch(events, "29/10/2026", "entry"), events[1]);
  assert.equal(historyConfirmsPunch(events, "29/10/2026", "exit")?.time, "18:41");
  assert.equal(historyConfirmsPunch(events, "30/10/2026", "entry"), undefined);
});

test("claimUncertainJob links one remote mark to one uncertain job", () => {
  const jobs = [
    { id: "entry-a", local_date: "29/10/2026", action: "entry" },
    { id: "exit-a", local_date: "29/10/2026", action: "exit" },
  ];
  const claimed = new Set();
  assert.equal(claimUncertainJob(jobs, "29/10/2026", "entry", claimed)?.id, "entry-a");
  assert.equal(claimUncertainJob(jobs, "29/10/2026", "entry", claimed), undefined);
  assert.equal(claimUncertainJob(jobs, "29/10/2026", "exit", claimed)?.id, "exit-a");
  assert.deepEqual([...claimed], ["entry-a", "exit-a"]);
});

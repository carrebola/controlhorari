import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("mobile notifications distinguish success, error, warning and legacy payloads", async () => {
  const handlers = {};
  const shown = [];
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self: { addEventListener(name, handler) { handlers[name] = handler; }, registration: {
      showNotification(title, options) { shown.push({ title, ...options }); return Promise.resolve(); },
    } },
  });
  for (const [level, symbol, icon] of [["success", "✅", "success"], ["error", "❌", "error"], ["warning", "⚠️", "warning"], [undefined, "ℹ️", null]]) {
    let completion;
    handlers.push({ data: { json: () => ({ title: "Entrada", level }) }, waitUntil(promise) { completion = promise; } });
    await completion;
    const result = shown.at(-1);
    assert.equal(result.title, `${symbol} Entrada`);
    assert.equal(result.icon, icon ? `/notification-${icon}.png` : "/icon-192.png");
    assert.ok(existsSync(new URL(`../public${result.icon}`, import.meta.url)));
    assert.equal(result.data.url, "/?view=notifications");
  }
});

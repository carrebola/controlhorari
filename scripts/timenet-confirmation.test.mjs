import assert from "node:assert/strict";
import test from "node:test";
import { observePunchOutcome } from "../cloudflare/src/timenet-confirmation.ts";

test("duplicate confirmation takes precedence over the working state and never confirms a punch", () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { innerText: "treballant\nCONFIRMACIÓ DE MARCATGE\nEstàs segur de repetir el mateix tipus de marcatge?\nL'últim marcatge registrat ja era del tipus 'Entrada'!\nAcceptar\nCancel·lar" } };
    assert.equal(observePunchOutcome(true), "duplicate_confirmation");
    assert.equal(observePunchOutcome(false), "duplicate_confirmation");
    globalThis.document.body.innerText = "treballant\nEntrada\nSortida";
    assert.equal(observePunchOutcome(true), "state_confirmed");
    assert.equal(observePunchOutcome(false), false);
    globalThis.document.body.innerText = "Entrada\nSortida";
    assert.equal(observePunchOutcome(false), "state_confirmed");
    assert.equal(observePunchOutcome(true), false);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

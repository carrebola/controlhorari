// This function runs in the Timenet page, so it must not depend on module scope.
export function observePunchOutcome(expectedWorking: boolean): "duplicate_confirmation" | "state_confirmed" | false {
  const text = document.body.innerText;
  if (/Estàs segur de repetir el mateix tipus de marcatge\s*\?/i.test(text)) {
    return "duplicate_confirmation";
  }
  const working = text.split("\n").some((line) => line.trim() === "treballant");
  return working === expectedWorking ? "state_confirmed" : false;
}

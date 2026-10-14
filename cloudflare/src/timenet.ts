import puppeteer, { type ElementHandle } from "@cloudflare/puppeteer";
import type { Env, JobAction } from "./types";
import { localClock } from "./time";

export interface PunchResult {
  ok: boolean;
  skipped?: boolean;
  uncertain?: boolean;
  time?: string;
  code?: string;
  message: string;
}

export interface TimenetHistoryEvent {
  localDate: string;
  action: JobAction;
  time: string;
}

const months = ["gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"];

export async function punchTimenet(env: Env, pin: string, action: JobAction, localDate: string): Promise<PunchResult> {
  const browser = await puppeteer.launch(env.BROWSER);
  let clicked = false;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(env.TIMENET_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.locator('input[name="pin"]').fill(pin);
    const loginButtonHandle = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.trim() === "Entrar") ?? null,
    );
    const loginButton = loginButtonHandle.asElement() as ElementHandle<Element> | null;
    if (!loginButton) throw new Error("No se encontró el botón de acceso a Timenet.");
    await loginButton.click();
    await loginButtonHandle.dispose();
    await page.waitForFunction(() => location.pathname === "/home" || document.body.innerText.includes("PIN incorrecte"), { timeout: 15_000 });
    if (new URL(page.url()).pathname !== "/home") {
      return { ok: false, code: "invalid_pin", message: "Timenet ha rechazado el PIN." };
    }

    await page.goto("https://timenet-wcp.gpisoftware.com/calendar", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector("gpi-calendar .click-day-control:not(.out-of-year-range)", { timeout: 15_000 });
    const [day, month, year] = localDate.split("/").map(Number);
    const calendarCheck = await page.evaluate(
      ({ day, monthName, year }) => {
        if (!new RegExp(`Any\\s+${year}`).test(document.body.innerText)) return { ok: false, message: "No se pudo confirmar el año de la agenda." };
        const headers = Array.from(document.querySelectorAll("gpi-calendar .container-mes"));
        const header = headers.find((element) => new RegExp(monthName, "i").test((element as HTMLElement).innerText));
        const monthContainer = header?.parentElement;
        const cell = Array.from(monthContainer?.querySelectorAll(".click-day-control:not(.out-of-year-range)") ?? [])
          .find((element) => element.querySelector(".click-day-text")?.textContent?.trim() === String(day));
        if (!cell) return { ok: false, message: "No se encontró el día actual en la agenda." };
        const text = [
          (cell as HTMLElement).innerText,
          cell.getAttribute("title"),
          cell.getAttribute("data-original-title"),
          cell.querySelector("[title], [data-original-title]")?.getAttribute("title"),
          cell.querySelector("[title], [data-original-title]")?.getAttribute("data-original-title"),
        ].filter(Boolean).join(" ");
        return { ok: true, text };
      },
      { day, monthName: months[month - 1], year },
    );
    if (!calendarCheck.ok) return { ok: false, code: "calendar_unavailable", message: calendarCheck.message ?? "No se pudo consultar la agenda." };
    if (/festiu|vacances|no definit/i.test(calendarCheck.text ?? "")) {
      return { ok: true, skipped: true, code: "non_working_day", message: "La agenda indica que hoy no corresponde fichar." };
    }

    await page.goto("https://timenet-wcp.gpisoftware.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
    const state = await page.evaluate(() => document.body.innerText.split("\n").some((line) => line.trim() === "treballant"));
    if ((action === "entry" && state) || (action === "exit" && !state)) {
      return { ok: true, skipped: true, code: "already_in_state", message: "Timenet ya estaba en el estado esperado; no se ha repetido el fichaje." };
    }
    const label = action === "entry" ? "Entrada" : "Sortida";
    const buttonHandle = await page.evaluateHandle(
      (expected) => Array.from(document.querySelectorAll("button, [role=button]")).find((element) => element.textContent?.trim() === expected) ?? null,
      label,
    );
    const button = buttonHandle.asElement() as ElementHandle<Element> | null;
    if (!button) throw new Error(`No se encontró el botón ${label}.`);
    clicked = true;
    await button.click();
    await page.waitForFunction(
      (expected) => document.body.innerText.split("\n").some((line) => line.trim() === "treballant") === expected,
      { timeout: 15_000 },
      action === "entry",
    );
    await buttonHandle.dispose();
    return {
      ok: true,
      time: localClock(Date.now(), env.TIME_ZONE),
      message: `${action === "entry" ? "Entrada" : "Salida"} registrada correctamente.`,
    };
  } catch (error) {
    return {
      ok: false,
      uncertain: clicked,
      code: clicked ? "confirmation_failed" : "automation_failed",
      message: clicked
        ? "Se pulsó el botón, pero no se pudo confirmar el resultado. Revisa Timenet antes de repetir."
        : error instanceof Error ? error.message : "No se pudo completar el fichaje.",
    };
  } finally {
    await browser.close();
  }
}

export async function readTimenetHistory(env: Env, pin: string): Promise<TimenetHistoryEvent[]> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(env.TIMENET_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.locator('input[name="pin"]').fill(pin);
    const loginHandle = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.trim() === "Entrar") ?? null,
    );
    const login = loginHandle.asElement() as ElementHandle<Element> | null;
    if (!login) throw new Error("No se encontró el acceso a Timenet.");
    await login.click();
    await page.waitForFunction(() => location.pathname === "/home" || document.body.innerText.includes("PIN incorrecte"), { timeout: 15_000 });
    await loginHandle.dispose();
    if (new URL(page.url()).pathname !== "/home") throw new Error("Timenet ha rechazado el PIN.");

    const historyHandle = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll("a, button, [role=tab], [role=menuitem], body *"))
        .find((element) => element.textContent?.trim() === "Els meus marcatges") ?? null,
    );
    const historyLink = historyHandle.asElement() as ElementHandle<Element> | null;
    if (!historyLink) throw new Error("No se encontró el historial de Timenet.");
    await historyLink.click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("table")).some((table) => /Marcatges/i.test((table as HTMLElement).innerText)), { timeout: 15_000 });
    await historyHandle.dispose();

    return await page.evaluate(() => {
      const table = Array.from(document.querySelectorAll("table")).find((element) => /Marcatges/i.test((element as HTMLElement).innerText));
      if (!table) return [];
      const headers = Array.from(table.querySelectorAll("tr th")).map((cell) => (cell.textContent ?? "").trim());
      const marksColumn = headers.findIndex((header) => /marcatges/i.test(header));
      const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
        Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim()),
      ).filter((cells) => /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0] ?? ""));
      return rows.flatMap((cells) => {
        const value = marksColumn >= 0 ? cells[marksColumn] ?? "" : cells.slice(2).join(" ");
        const times = Array.from(value.matchAll(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g), (match) => match[0].padStart(5, "0"));
        return times.map((time, index) => ({
          localDate: cells[0],
          action: index % 2 === 0 ? "entry" as const : "exit" as const,
          time,
        }));
      });
    });
  } finally {
    await browser.close();
  }
}

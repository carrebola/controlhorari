import puppeteer, { type ElementHandle, type Page } from "@cloudflare/puppeteer";
import type { Env, JobAction } from "./types";
import { localClock, localDate as currentLocalDate } from "./time";
import { historyConfirmsPunch, parseTimenetHistory, type TimenetHistoryEvent } from "./timenet-history";
import { observePunchOutcome } from "./timenet-confirmation";
import { guardedPunch } from "./punch-guard";

export interface PunchResult {
  ok: boolean;
  skipped?: boolean;
  uncertain?: boolean;
  time?: string;
  code?: string;
  message: string;
}

const months = ["gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"];

export class TimenetError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

async function launchBrowser(env: Env) {
  try {
    return await puppeteer.launch(env.BROWSER);
  } catch (cause) {
    console.error("No se pudo iniciar el navegador de Timenet", cause);
    return null;
  }
}

function findLoginControl() {
  const nodes = Array.from(document.querySelectorAll("button, input[type=submit], [role=button], a"));
  return nodes.find((element) => {
    const label = `${(element as HTMLInputElement).value || ""} ${element.textContent || ""}`.replace(/\s+/g, " ").trim();
    return /^(Entrar|Entra)$/i.test(label);
  }) ?? null;
}

async function loginTimenet(page: Page, env: Env, pin: string) {
  page.setDefaultTimeout(20_000);
  await page.goto(env.TIMENET_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 25_000 });
  await page.waitForSelector('input[name="pin"]', { timeout: 20_000 });
  await page.locator('input[name="pin"]').fill(pin);
  await page.waitForFunction(findLoginControl, { timeout: 20_000 });
  const loginHandle = await page.evaluateHandle(findLoginControl);
  const login = loginHandle.asElement() as ElementHandle<Element> | null;
  if (!login) {
    await loginHandle.dispose();
    throw new Error("No se encontró el acceso a Timenet.");
  }
  await login.click();
  await loginHandle.dispose();
  await page.waitForFunction(() => location.pathname === "/home" || /PIN incorrecte/i.test(document.body.innerText), { timeout: 20_000 });
  if (new URL(page.url()).pathname !== "/home") throw new TimenetError("Timenet ha rechazado el PIN. Actualízalo en Configuración y vuelve a sincronizar.", 422);
}

async function readHistoryOnPage(page: Page) {
  const historyHandle = await page.evaluateHandle(
    () => Array.from(document.querySelectorAll("a, button, [role=tab], [role=menuitem], body *"))
      .find((element) => element.textContent?.trim() === "Els meus marcatges") ?? null,
  );
  const historyLink = historyHandle.asElement() as ElementHandle<Element> | null;
  if (!historyLink) {
    await historyHandle.dispose();
    throw new Error("No se encontró el historial de Timenet.");
  }
  const checksResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/cp/checks" && response.request().method() !== "OPTIONS" && response.status() === 200);
  await historyLink.click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll("table")).some((table) => /Marcatges/i.test((table as HTMLElement).innerText)), { timeout: 20_000 });
  await historyHandle.dispose();
  return parseTimenetHistory(await (await checksResponse).json());
}

async function ensureWorkingDay(page: Page, localDate: string) {
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
  if (!calendarCheck.ok) return { ok: false as const, code: "calendar_unavailable", message: calendarCheck.message ?? "No se pudo consultar la agenda." };
  if (/festiu|vacances|no definit/i.test(calendarCheck.text ?? "")) {
    return { ok: true as const, skipped: true as const, code: "non_working_day", message: "La agenda indica que hoy no corresponde fichar." };
  }
  return null;
}

async function punchOnPage(
  page: Page,
  action: JobAction,
  localDate: string,
  timeZone: string,
  beforeClick?: () => Promise<boolean>,
): Promise<PunchResult> {
  let clicked = false;
  try {
    await page.goto("https://timenet-wcp.gpisoftware.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button, [role=button]")).some((element) => /^(Entrada|Sortida)$/.test(element.textContent?.trim() ?? "")), { timeout: 15_000 });
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
    if (!button) {
      await buttonHandle.dispose();
      throw new Error(`No se encontró el botón ${label}.`);
    }
    if (currentLocalDate(Date.now(), timeZone) !== localDate) {
      await buttonHandle.dispose();
      return { ok: true, skipped: true, code: "date_changed", message: "El día del fichaje ha cambiado; no se ha enviado." };
    }
    if (beforeClick && !(await beforeClick())) {
      await buttonHandle.dispose();
      return { ok: true, skipped: true, code: "disabled", message: "La automatización se ha pausado; no se ha enviado el fichaje." };
    }
    clicked = true;
    await button.click();
    await buttonHandle.dispose();
    return await confirmPunchAfterClick(page, action, localDate, timeZone);
  } catch (error) {
    if (clicked) {
      try {
        return await confirmViaHistory(page, action, localDate);
      } catch (historyError) {
        console.error("No se pudo confirmar el fichaje en el historial de Timenet", historyError);
      }
    }
    return {
      ok: false,
      uncertain: clicked,
      code: clicked ? "confirmation_failed" : "automation_failed",
      message: clicked
        ? "Se pulsó el botón, pero no se pudo confirmar el resultado. Revisa Timenet antes de repetir."
        : error instanceof Error ? error.message : "No se pudo completar el fichaje.",
    };
  }
}

async function confirmPunchAfterClick(
  page: Page,
  action: JobAction,
  localDate: string,
  timeZone: string,
): Promise<PunchResult> {
  try {
    const outcomeHandle = await page.waitForFunction(observePunchOutcome, { timeout: 15_000 }, action === "entry");
    const outcome = await outcomeHandle.jsonValue();
    await outcomeHandle.dispose();
    if (outcome === "duplicate_confirmation") {
      return {
        ok: false,
        uncertain: false,
        code: "duplicate_confirmation_required",
        message: "Timenet pide confirmar un fichaje del mismo tipo que el anterior. No se ha aceptado ni enviado la repetición. Revisa el historial de Timenet.",
      };
    }
    return {
      ok: true,
      time: localClock(Date.now(), timeZone),
      message: `${action === "entry" ? "Entrada" : "Salida"} registrada correctamente.`,
    };
  } catch (uiError) {
    console.error("La UI de Timenet no confirmó el fichaje a tiempo; se comprueba el historial", uiError);
    return confirmViaHistory(page, action, localDate);
  }
}

async function confirmViaHistory(page: Page, action: JobAction, localDate: string): Promise<PunchResult> {
  const history = await readHistoryOnPage(page);
  const match = historyConfirmsPunch(history.events, localDate, action);
  if (match) {
    return {
      ok: true,
      time: match.time,
      code: "confirmed_by_history",
      message: `${action === "entry" ? "Entrada" : "Salida"} confirmada en el historial de Timenet.`,
    };
  }
  return {
    ok: false,
    uncertain: true,
    code: "confirmation_failed",
    message: "Se pulsó el botón, pero no se pudo confirmar el resultado. Revisa Timenet antes de repetir.",
  };
}

async function withTimenetPage<T>(env: Env, pin: string, run: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser(env);
  if (!browser) throw new TimenetError("No se pudo iniciar el navegador de Timenet. Si estás en local, revisa el servidor de Cloudflare; después vuelve a intentarlo.", 503);
  try {
    const page = await browser.newPage();
    await loginTimenet(page, env, pin);
    return await run(page, browser);
  } finally {
    await browser.close().catch((cause: unknown) => console.error("No se pudo cerrar el navegador de Timenet", cause));
  }
}

export async function readTimenetHistory(env: Env, pin: string): Promise<ReturnType<typeof parseTimenetHistory>> {
  try {
    return await withTimenetPage(env, pin, (page) => readHistoryOnPage(page));
  } catch (cause) {
    if (cause instanceof TimenetError) throw cause;
    console.error("No se pudo leer el historial de Timenet", cause);
    throw new TimenetError("No se pudo consultar el historial de Timenet. Comprueba la conexión y vuelve a intentarlo.", 502);
  }
}

/** One browser session: history check + punch. Avoids the double-login that made automatic punches fail closed. */
export async function guardedTimenetPunch(
  env: Env,
  userId: string,
  pin: string,
  localDate: string,
  action: JobAction,
  options: { manual?: boolean; timeZone?: string; beforeClick?: () => Promise<boolean> } = {},
): Promise<PunchResult> {
  const timeZone = options.timeZone ?? env.TIME_ZONE;
  const manual = Boolean(options.manual);
  const browser = await launchBrowser(env);
  if (!browser) {
    return { ok: false, uncertain: false, code: "browser_unavailable", message: "No se pudo iniciar el navegador de Timenet. No se ha enviado ningún fichaje." };
  }

  let history: { days: { localDate: string }[]; events: TimenetHistoryEvent[] } | null = null;
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await loginTimenet(page, env, pin);
    history = await readHistoryOnPage(page);
  } catch (cause) {
    await browser.close().catch((error: unknown) => console.error("No se pudo cerrar el navegador de Timenet", error));
    if (cause instanceof TimenetError && cause.status === 422) {
      return { ok: false, uncertain: false, code: "invalid_pin", message: cause.message };
    }
    console.error("No se pudo preparar la sesión de Timenet", cause);
    return { ok: false, uncertain: false, code: "history_unavailable", message: "No se pudo comprobar el historial de Timenet. No se ha enviado el fichaje." };
  }

  try {
    return await guardedPunch(
      env,
      userId,
      localDate,
      action,
      async () => history!,
      async () => {
        if (!manual) {
          const calendar = await ensureWorkingDay(page!, localDate);
          if (calendar) return calendar;
        }
        return punchOnPage(page!, action, localDate, timeZone, options.beforeClick);
      },
    );
  } finally {
    await browser.close().catch((cause: unknown) => console.error("No se pudo cerrar el navegador de Timenet", cause));
  }
}

export async function punchTimenet(env: Env, pin: string, action: JobAction, localDate: string, manual = false, timeZone: string = env.TIME_ZONE, beforeClick?: () => Promise<boolean>): Promise<PunchResult> {
  // Kept for callers that already verified history; prefer guardedTimenetPunch for end-to-end punches.
  const browser = await launchBrowser(env);
  if (!browser) {
    return { ok: false, uncertain: false, code: "browser_unavailable", message: "No se pudo iniciar el navegador de Timenet. No se ha enviado ningún fichaje." };
  }
  try {
    const page = await browser.newPage();
    await loginTimenet(page, env, pin);
    if (!manual) {
      const calendar = await ensureWorkingDay(page, localDate);
      if (calendar) return calendar;
    }
    return await punchOnPage(page, action, localDate, timeZone, beforeClick);
  } catch (error) {
    if (error instanceof TimenetError && error.status === 422) {
      return { ok: false, code: "invalid_pin", message: error.message };
    }
    return {
      ok: false,
      uncertain: false,
      code: "automation_failed",
      message: error instanceof Error ? error.message : "No se pudo completar el fichaje.",
    };
  } finally {
    await browser.close().catch((cause: unknown) => console.error("No se pudo cerrar el navegador de fichaje", cause));
  }
}

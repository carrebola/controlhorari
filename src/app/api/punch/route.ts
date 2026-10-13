import { NextRequest, NextResponse } from "next/server";
import { chromium } from "playwright";
import { createHash } from "node:crypto";

const state = globalThis as typeof globalThis & { punchAttempts?: Set<string> };
const attempts = state.punchAttempts ??= new Set<string>();
const loginUrl = "https://timenet-wcp.gpisoftware.com/login/1b64e567-7e18-40a5-b545-f0ab35cc1810";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { pin, action, date, target } = body;
  if (typeof pin !== "string" || !/^\d+$/.test(pin) || !["entry", "exit"].includes(action) || typeof target !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(target)) return NextResponse.json({ ok: false, message: "Datos de fichaje inválidos." }, { status: 400 });
  const now = new Date();
  const today = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
  const seconds = (value: string) => value.split(":").reduce((total, n) => total * 60 + Number(n), 0);
  if (date !== today || seconds(clock) < seconds(target) || seconds(clock) - seconds(target) > 90) return NextResponse.json({ ok: false, message: "El horario de fichaje ya no corresponde a este momento." }, { status: 409 });
  const key = createHash("sha256").update(`${pin}:${date}:${action}`).digest("hex");
  if (attempts.has(key)) return NextResponse.json({ ok: false, message: "Este fichaje ya se ha intentado. Revisa el registro." }, { status: 409 });
  attempts.add(key);
  let browser;
  let clicked = false;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="pin"]').fill(pin);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("https://timenet-wcp.gpisoftware.com/home");
    await page.goto("https://timenet-wcp.gpisoftware.com/calendar", { waitUntil: "domcontentloaded" });
    const months = ["gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"];
    const [day, month, year] = today.split("/").map(Number);
    await page.locator("gpi-calendar .click-day-control").first().waitFor();
    if (!(await page.locator("body").innerText()).match(new RegExp(`Any\\s+${year}`))) throw new Error("No se pudo comprobar el año de la agenda.");
    const header = page.locator("gpi-calendar .container-mes").filter({ hasText: new RegExp(months[month - 1], "i") }).first();
    const cell = header.locator("xpath=..").locator(".click-day-control:not(.out-of-year-range)").filter({ has: page.locator(".click-day-text", { hasText: new RegExp(`^${day}$`) }) }).first();
    await cell.hover();
    const tooltip = page.locator('.gpi-tooltip-calendar:visible, [role="tooltip"]:visible').last();
    await tooltip.waitFor({ state: "visible", timeout: 3000 });
    const planned = await tooltip.innerText();
    if (/festiu|vacances|no definit/i.test(planned) || !/\d{1,2}:\d{2}\s*a\s*\d{1,2}:\d{2}/.test(planned)) throw new Error("Hoy no hay una jornada de trabajo confirmada en la agenda.");
    await page.goto("https://timenet-wcp.gpisoftware.com/home", { waitUntil: "domcontentloaded" });
    const button = page.getByText(action === "entry" ? "Entrada" : "Sortida", { exact: true });
    await button.waitFor();
    const working = await page.getByText("treballant", { exact: true }).isVisible();
    if ((action === "entry" && working) || (action === "exit" && !working)) return NextResponse.json({ ok: true, skipped: true, message: "El estado actual ya corresponde al fichaje. No se ha pulsado." });
    clicked = true;
    await button.click();
    await page.waitForFunction((expected) => Array.from(document.querySelectorAll("body *")).some((element) => element.textContent?.trim() === "treballant" && (element as HTMLElement).offsetParent !== null) === expected, action === "entry", { timeout: 15_000 });
    return NextResponse.json({ ok: true, action, time: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date()) });
  } catch (error) {
    if (!clicked) attempts.delete(key);
    return NextResponse.json({ ok: false, uncertain: clicked, message: clicked ? "Se ha pulsado el botón, pero no se pudo confirmar. Revisa Timenet antes de repetir." : error instanceof Error ? error.message : "No se pudo fichar." }, { status: 502 });
  } finally { await browser?.close(); }
}

import { NextRequest, NextResponse } from "next/server";
import { chromium } from "playwright";

type ClockRequest = {
  url?: string;
  pin?: string;
  actionText?: string;
  mode?: "clock" | "portal";
  includeCalendar?: boolean;
};

function visibleButtonSnapshot(buttons: { text: string; disabled: boolean }[]) {
  return buttons.filter((button) => button.text.length > 0).slice(0, 30);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ClockRequest;
  const url = body.url?.trim();
  const pin = body.pin?.trim();
  const actionText = body.actionText?.trim();

  if (!url || !pin) {
    return NextResponse.json(
      { ok: false, message: "Faltan la URL o el PIN." },
      { status: 400 },
    );
  }

  if (!/^\d+$/.test(pin)) {
    return NextResponse.json(
      { ok: false, message: "El PIN solo puede contener números." },
      { status: 400 },
    );
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    let dashboardText = "";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    if (body.mode === "portal") {
      if (new URL(url).hostname !== "timenet-wcp.gpisoftware.com") {
        return NextResponse.json({ ok: false, message: "Utiliza la dirección del portal de Timenet." }, { status: 400 });
      }
      await page.locator('input[name="pin"]').fill(pin);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      try {
        await page.waitForURL("https://timenet-wcp.gpisoftware.com/home", { timeout: 15_000 });
      } catch {
        return NextResponse.json({ ok: false, message: "No se ha podido acceder al portal. Comprueba el PIN.", pageText: await page.locator("body").innerText() }, { status: 401 });
      }
      // Timenet may render navigation as links, buttons, or plain menu items.
      dashboardText = await page.locator("body").innerText();
      const historyNavigation = page.locator('a, button, [role="tab"], [role="menuitem"]')
        .filter({ hasText: /^\s*Els meus marcatges\s*$/i });
      if (await historyNavigation.count()) {
        await historyNavigation.first().click({ timeout: 10_000 });
      } else {
        await page.getByText("Els meus marcatges", { exact: true }).first().click({ timeout: 10_000 });
      }
      await page.locator("table").filter({ hasText: "Marcatges" }).first().waitFor({ timeout: 15_000 });
    } else {
    for (const digit of pin) {
      await page.getByRole("button", { name: digit, exact: true }).click();
      await page.waitForTimeout(120);
    }
    }

    if (actionText && body.mode !== "portal") {
      await page
        .getByRole("button", { name: new RegExp(escapeRegExp(actionText), "i") })
        .first()
        .click({ timeout: 10_000 });
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {
      // Some clock pages keep background polling open. The UI state is enough.
    });

    const buttons = await page.locator("button, [role=button]").evaluateAll(
      (elements) =>
        elements.map((element) => ({
          text:
            (element.textContent ||
              element.getAttribute("aria-label") ||
              "").trim(),
          disabled:
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true",
        })),
    );

    const pageText = (await page.locator("body").innerText()).slice(0, body.mode === "portal" ? 30_000 : 1200);
    const history = body.mode === "portal" ? await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      const table = tables.find((element) => /Marcatges/i.test(element.innerText));
      if (!table) return null;
      const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
        Array.from(row.querySelectorAll("td")).map((cell) => cell.innerText.trim()),
      ).filter((cells) => /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0] || ""));
      const text = document.body.innerText;
      return {
        rows,
        planned: text.match(/Hores previstes:\s*([^\n]+)/i)?.[1]?.trim() || "",
        worked: text.match(/Hores treballades:\s*([^\n]+)/i)?.[1]?.trim() || "",
        difference: text.match(/Difer[eè]ncia:\s*([^\n]+)/i)?.[1]?.trim() || "",
      };
    }) : undefined;
    if (body.mode === "portal" && !history?.rows.length) {
      return NextResponse.json({ ok: false, message: "Se ha accedido al portal, pero no se pudo leer la tabla de marcajes." }, { status: 502 });
    }
    let calendar = null;
    if (body.mode === "portal" && body.includeCalendar !== false) {
      try {
        await page.goto("https://timenet-wcp.gpisoftware.com/calendar", { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.locator("gpi-calendar .click-day-control:not(.out-of-year-range)").first().waitFor({ timeout: 15_000 });
        calendar = await page.evaluate(() => ({
          text: document.body.innerText,
          schedule: Array.from(document.querySelectorAll("tr, [data-date], [title], [aria-label]")).flatMap((element) => {
            const text = [(element as HTMLElement).innerText, element.getAttribute("title"), element.getAttribute("aria-label"), ...Array.from(element.querySelectorAll("[title], [aria-label]")).map((child) => child.getAttribute("title") || child.getAttribute("aria-label"))].filter(Boolean).join(" ");
            const rawDate = element.getAttribute("data-date") || element.closest("[data-date]")?.getAttribute("data-date") || text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0];
            if (!rawDate) return [];
            const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate.split("-").reverse().join("/") : rawDate;
            if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return [];
            const intervals = Array.from(text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:a|–|—|-)\s*([01]?\d|2[0-3]):([0-5]\d)\b/g), (match) => ({
              entry: `${match[1].padStart(2, "0")}:${match[2]}`,
              exit: `${match[3].padStart(2, "0")}:${match[4]}`,
            }));
            const [day, month, year] = date.split("/").map(Number);
            return intervals.length ? [{ date, weekday: (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7, intervals }] : [];
          }),
          tables: Array.from(document.querySelectorAll("table")).map((table) =>
            Array.from(table.querySelectorAll("tr")).map((row) =>
              Array.from(row.querySelectorAll("th, td")).map((cell) => ({
                text: (cell as HTMLElement).innerText.trim(),
                title: cell.getAttribute("title"),
                label: cell.getAttribute("aria-label"),
                date: cell.getAttribute("data-date"),
                className: cell.className,
              })),
            ),
          ),
        }));
        const monthNames = ["gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"];
        const year = calendar.text.match(/\bAny\s+(\d{4})/i)?.[1];
        if (year) {
          const tooltipDays: { date: string; weekday: number; intervals: { entry: string; exit: string }[]; kind: string }[] = [];
          const monthTables = page.locator("gpi-calendar .container-mes");
          for (let tableIndex = 0; tableIndex < await monthTables.count(); tableIndex++) {
            const table = monthTables.nth(tableIndex);
            const monthText = (await table.innerText()).trim().toLowerCase().match(/gener|febrer|març|abril|maig|juny|juliol|agost|setembre|octubre|novembre|desembre/)?.[0] || "";
            const month = monthNames.indexOf(monthText);
            if (month < 0) continue;
            if (!history?.rows.some((row) => Number(row[0].split("/")[1]) === month + 1)) continue;
            const cells = table.locator("xpath=..").locator(".container-dies .click-day-control:not(.out-of-year-range)");
            for (let index = 0; index < await cells.count(); index++) {
              const cell = cells.nth(index);
              const dayText = (await cell.locator(".click-day-text").innerText()).trim();
              if (!/^\d{1,2}$/.test(dayText)) continue;
              const day = Number(dayText);
              if (day < 1 || day > new Date(Date.UTC(Number(year), month + 1, 0)).getUTCDate()) continue;
              const target = cell.locator("[data-original-title], [data-bs-original-title], [title], [data-content]").first();
              const trigger = await target.count() ? target : cell;
              let tooltipText = await trigger.evaluate((element) => ["data-original-title", "data-bs-original-title", "title", "data-content", "aria-label"].map((name) => element.getAttribute(name) || "").join(" "));
              if (!tooltipText.trim()) {
                await trigger.hover();
                const tooltip = page.locator('.gpi-tooltip-calendar:visible, [role="tooltip"]:visible, .tooltip:visible, .popover:visible').last();
                try {
                  await tooltip.waitFor({ state: "visible", timeout: 700 });
                  tooltipText = await tooltip.innerText();
                } catch { continue; }
              }
              const intervals = Array.from(tooltipText.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:a|–|—|-)\s*([01]?\d|2[0-3]):([0-5]\d)\b/g), (match) => ({ entry: `${match[1].padStart(2, "0")}:${match[2]}`, exit: `${match[3].padStart(2, "0")}:${match[4]}` }));
              const kind = /festiu/i.test(tooltipText) ? "holiday" : /vacances/i.test(tooltipText) ? "vacation" : /no definit/i.test(tooltipText) ? "undefined" : intervals.length ? "work" : "unknown";
              const date = `${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;
              tooltipDays.push({ date, weekday: (new Date(Date.UTC(Number(year), month, day)).getUTCDay() + 6) % 7, intervals, kind });
            }
          }
          if (tooltipDays.length) calendar.schedule = tooltipDays;
        }
        if (!calendar.schedule.length) {
          calendar = { ...calendar, error: "La agenda ha cargado, pero no se han identificado fechas con intervalos de horario." };
        }
      } catch {
        calendar = { error: "No se pudo cargar el calendario con esta sesión." };
      }
    }

    // Only explicit planned intervals are schedules; recorded punches are not.
    const userSchedule = (history?.rows || []).flatMap((cells) => {
      const intervals = Array.from((cells[1] || "").matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s+a\s+([01]?\d|2[0-3]):([0-5]\d)\b/g), (match) => ({
        entry: `${match[1].padStart(2, "0")}:${match[2]}`,
        exit: `${match[3].padStart(2, "0")}:${match[4]}`,
      }));
      return intervals.length ? [{ date: cells[0], intervals, source: "Timenet · horario previsto" }] : [];
    });

    return NextResponse.json({
      ok: true,
      title: await page.title(),
      finalUrl: page.url(),
      actionClicked: Boolean(actionText),
      buttons: visibleButtonSnapshot(buttons),
      pageText,
      history,
      dashboardText,
      calendar,
      userSchedule,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "No se pudo completar la automatización.",
      },
      { status: 500 },
    );
  } finally {
    await browser.close();
  }
}

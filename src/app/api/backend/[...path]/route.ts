import { NextRequest, NextResponse } from "next/server";

const sessionCookie = "controlhorari_session";
export const maxDuration = 120;

async function proxy(request: NextRequest, context: RouteContext<"/api/backend/[...path]">) {
  const { path } = await context.params;
  if (process.env.NODE_ENV === "production" && !process.env.WORKER_API_URL) {
    return NextResponse.json({ ok: false, message: "Falta configurar el servidor de automatización." }, { status: 503 });
  }
  const backendUrl = process.env.WORKER_API_URL || "http://127.0.0.1:8787";
  const target = new URL(`/api/${path.join("/")}`, backendUrl);
  target.search = request.nextUrl.search;
  const headers = new Headers({ accept: "application/json" });
  const token = request.cookies.get(sessionCookie)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  let upstream: Response;
  try { upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(110_000),
  }); } catch {
    const response = NextResponse.json({ ok: false, message: "No se pudo confirmar la respuesta del servidor. Sincroniza antes de repetir un fichaje." }, { status: 502 });
    response.headers.set("cache-control", "no-store");
    if (path.join("/") === "auth/logout") response.cookies.delete(sessionCookie);
    return response;
  }
  const raw = await upstream.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    data = { ok: false, message: "El servidor de automatización devolvió una respuesta no válida." };
  }
  const responseData = { ...data };
  const isLogin = path.join("/") === "auth/login";
  const isLogout = path.join("/") === "auth/logout";
  const sessionToken = typeof responseData.token === "string" ? responseData.token : undefined;
  delete responseData.token;
  const response = NextResponse.json(responseData, { status: upstream.status });
  response.headers.set("cache-control", "no-store");
  if (isLogin && upstream.ok && sessionToken) {
    const expiresAt = typeof responseData.expiresAt === "number" ? responseData.expiresAt : Date.now() + 30 * 24 * 60 * 60 * 1000;
    response.cookies.set(sessionCookie, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: new Date(expiresAt),
    });
  }
  if (isLogout) response.cookies.delete(sessionCookie);
  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;

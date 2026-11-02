import { NextResponse } from "next/server";

export function GET() {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.npm_package_version ||
    "dev";
  return NextResponse.json(
    { version },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}

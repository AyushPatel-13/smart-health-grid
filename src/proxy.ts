import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Optimistic gate only: redirects anonymous visitors to /login and refreshes
// the Supabase session cookie. Real authorisation happens on the server
// (getCurrentUser + role checks) and in Postgres RLS.

const PUBLIC = ["/login", "/register", "/patient"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const supabaseMode =
    process.env.SHG_DATA_MODE !== "demo" &&
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    !!process.env.DATABASE_URL;

  let response = NextResponse.next({ request });
  let hasSession: boolean;

  if (supabaseMode) {
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    hasSession = !!data.user;
  } else {
    hasSession = !!request.cookies.get("shg_session")?.value;
  }

  if (!hasSession && !isPublic && pathname !== "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/cron).*)"],
};

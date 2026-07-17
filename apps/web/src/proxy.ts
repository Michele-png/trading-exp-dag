import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicEnvironment } from "@/lib/env";

const PUBLIC_PATHS = new Set(["/login", "/auth/callback"]);

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  try {
    const environment = getPublicEnvironment();
    const supabase = createServerClient(
      environment.NEXT_PUBLIC_SUPABASE_URL,
      environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll(cookieUpdates) {
            for (const { name, value } of cookieUpdates) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookieUpdates) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const isPublic = PUBLIC_PATHS.has(request.nextUrl.pathname);

    if (!user && !isPublic) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set(
        "next",
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
      );
      return NextResponse.redirect(loginUrl);
    }

    if (user && request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  } catch {
    // Runtime pages and API handlers surface a precise configuration error.
    // Avoid turning a missing environment variable into a build dependency.
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

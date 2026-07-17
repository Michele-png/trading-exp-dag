import { handleApiRequest } from "@/lib/server/api";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ segments: string[] }>;
};

async function route(request: Request, context: Context) {
  const { segments } = await context.params;
  return handleApiRequest(request, segments);
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;

import { z } from "zod";

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

const serverEnvironmentSchema = publicEnvironmentSchema.extend({
  SUPABASE_SECRET_KEY: z.string().min(1),
  API_TOKEN_PEPPER: z.string().min(32),
});

export type PublicEnvironment = z.infer<typeof publicEnvironmentSchema>;
export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

function parseEnvironment<T>(
  schema: z.ZodType<T>,
  values: Record<string, string | undefined>,
  context: string,
): T {
  const parsed = schema.safeParse(values);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");

    throw new Error(
      `${context} is not configured. Set ${missing || "the required environment variables"} at runtime.`,
    );
  }

  return parsed.data;
}

/**
 * Read public configuration only when a request or browser action needs it.
 * Keeping validation out of module scope lets `next build` run without secrets.
 */
export function getPublicEnvironment(
  environment: Record<string, string | undefined> = {
    // Direct references let Next.js inline public values in client bundles.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
): PublicEnvironment {
  return parseEnvironment(
    publicEnvironmentSchema,
    {
      NEXT_PUBLIC_SUPABASE_URL: environment.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    "Supabase public configuration",
  );
}

/**
 * Server-only callers should invoke this inside request handlers, never at
 * module initialization time.
 */
export function getServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ServerEnvironment {
  return parseEnvironment(
    serverEnvironmentSchema,
    {
      NEXT_PUBLIC_SUPABASE_URL: environment.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: environment.SUPABASE_SECRET_KEY,
      API_TOKEN_PEPPER: environment.API_TOKEN_PEPPER,
    },
    "QDAG server configuration",
  );
}

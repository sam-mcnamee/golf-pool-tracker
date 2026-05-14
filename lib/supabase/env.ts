import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1)
});

const serverSchema = clientSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ADMIN_SECRET: z.string().min(12).optional(),
  CRON_SECRET: z.string().min(12).optional(),
  GITHUB_WORKFLOW_TOKEN: z.string().min(1).optional(),
  GITHUB_REPOSITORY: z.string().min(3).optional()
});

export function getClientEnv() {
  // In the browser, `process.env` is not a real populated object at runtime.
  // Next.js inlines individual `process.env.NEXT_PUBLIC_*` references during build.
  return clientSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  });
}

export function getServerEnv() {
  return serverSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_SECRET: process.env.ADMIN_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    GITHUB_WORKFLOW_TOKEN: process.env.GITHUB_WORKFLOW_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
  });
}


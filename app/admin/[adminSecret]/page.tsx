import { notFound } from "next/navigation";
import { getServerEnv } from "@/lib/supabase/env";
import { AdminTierLock } from "@/components/admin-tier-lock";

export default async function AdminPage({ params }: { params: Promise<{ adminSecret: string }> }) {
  const { adminSecret } = await params;
  const env = getServerEnv();

  if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin: Tier lock</h1>
        <p className="text-sm text-slate-600">Paste odds JSON (or a URL to fetch) to create the snapshot + tiers.</p>
      </div>
      <AdminTierLock />
    </div>
  );
}


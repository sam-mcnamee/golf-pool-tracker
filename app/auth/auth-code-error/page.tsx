import Link from "next/link";

export default async function AuthCodeErrorPage({
  searchParams
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const q = await searchParams;
  const reason = q.reason;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Sign-in could not finish</h1>
      <p className="text-sm text-slate-600">
        The auth callback did not complete. This sometimes happens if the link expired or the provider returned an
        error.
      </p>
      {reason ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{reason}</p> : null}
      <Link href="/login" className="inline-block text-sm font-medium text-club-navy underline">
        Back to sign in
      </Link>
    </div>
  );
}

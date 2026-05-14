/** Best-effort display name from Supabase Auth user_metadata / identity_data (e.g. Google OAuth). */
export function displayNameFromOAuthMetadata(
  meta: Record<string, unknown> | null | undefined,
  email: string | null | undefined
): string | null {
  const m = meta ?? {};
  const s = (k: string): string => {
    const v = m[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const gn = s("given_name");
  const fn = s("family_name");
  const fullFromParts = gn && fn ? `${gn} ${fn}`.trim() : gn || fn;
  const out =
    s("name") ||
    s("full_name") ||
    fullFromParts ||
    s("preferred_username") ||
    s("user_name") ||
    (email ? email.split("@")[0]?.trim() ?? "" : "");
  const t = out.trim();
  return t.length ? t : null;
}

export function profileDisplayNameFromUser(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: { identity_data?: Record<string, unknown> }[] | null;
}): string | null {
  const identityMeta = user.identities?.find((identity) => identity.identity_data)?.identity_data;
  const merged: Record<string, unknown> = { ...(identityMeta ?? {}), ...(user.user_metadata ?? {}) };
  return displayNameFromOAuthMetadata(merged, user.email ?? null);
}

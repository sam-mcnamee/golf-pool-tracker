"use client";

import { useRouter } from "next/navigation";

export type AdminTournamentOption = {
  id: string;
  name: string;
  status: string;
};

export function AdminTournamentPicker({ tournaments, currentId }: { tournaments: AdminTournamentOption[]; currentId: string }) {
  const router = useRouter();
  if (tournaments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <label htmlFor="admin-tournament" className="text-sm font-medium text-slate-700">
        Tournament
      </label>
      <select
        id="admin-tournament"
        className="max-w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={currentId}
        onChange={(e) => {
          const id = e.target.value;
          router.push(id ? `/admin?tournamentId=${id}` : "/admin");
        }}
      >
        {tournaments.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.status})
          </option>
        ))}
      </select>
    </div>
  );
}

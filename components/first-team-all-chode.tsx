import Image from "next/image";
import { PLACEHOLDER_HEADSHOT_URL, type FirstTeamAllChodeSlot } from "@/lib/domain/first-team-all-chode";

export type FirstTeamAllChodeTierSlot = FirstTeamAllChodeSlot | null;

function formatScore(value: number | null): string {
  if (value === null) return "-";
  if (value > 0) return `+${value}`;
  return String(value);
}

function HeadshotImage({ src, alt }: { src: string; alt: string }) {
  const isLocal = src.startsWith("/");

  if (isLocal) {
    return (
      <Image
        src={src}
        alt={alt}
        width={72}
        height={72}
        className="h-[72px] w-[72px] rounded-full border border-club-gold/40 bg-white object-cover"
        sizes="72px"
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={72}
      height={72}
      className="h-[72px] w-[72px] rounded-full border border-club-gold/40 bg-white object-cover"
      loading="lazy"
    />
  );
}

export function FirstTeamAllChode({ slots }: { slots: FirstTeamAllChodeTierSlot[] }) {
  return (
    <div className="w-full border-t border-club-gold/15 pt-4">
      <h3 className="text-base font-semibold text-club-navy">First Team All-Chode:</h3>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {slots.map((slot, index) => {
          const tier = index + 1;

          return (
            <div
              key={`all-chode-tier-${tier}`}
              className="flex min-w-0 flex-col items-center rounded-lg border border-club-gold/20 bg-club-cream/30 px-3 py-4 text-center"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Tier {tier}</div>
              {slot ? (
                <>
                  <div className="mt-3">
                    <HeadshotImage src={slot.headshotUrl || PLACEHOLDER_HEADSHOT_URL} alt={slot.name} />
                  </div>
                  <div className="mt-3 w-full min-w-0 text-pretty text-sm font-medium leading-snug text-club-navy">{slot.name}</div>
                  <div className="mt-1 text-sm font-semibold tabular-nums text-red-700">{formatScore(slot.totalScore)}</div>
                </>
              ) : (
                <>
                  <div className="mt-3 flex h-[72px] w-[72px] items-center justify-center rounded-full border border-dashed border-club-gold/40 bg-white/80 text-xs text-slate-500">
                    —
                  </div>
                  <p className="mt-3 text-pretty text-xs text-slate-600">No scored golfers yet</p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

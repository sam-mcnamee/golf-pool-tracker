import Image from "next/image";
import Link from "next/link";
import { HeaderAuth } from "@/components/header-auth";

export function Header() {
  return (
    <header className="border-b border-club-gold/25 bg-club-cream/50">
      <div className="container flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 sm:h-16 sm:flex-nowrap sm:gap-4 sm:py-0">
        <Link href="/" className="flex min-w-0 flex-1 items-center gap-2 text-club-navy sm:flex-none sm:gap-3">
          <Image
            src="/logo.png"
            alt="Chode Emporium Golf Pool crest"
            width={56}
            height={31}
            className="h-9 w-auto shrink-0 rounded-md border border-club-gold/40 bg-white object-contain shadow-sm"
            sizes="56px"
          />
          <span className="truncate text-sm font-semibold tracking-tight sm:hidden">Chode Pool</span>
          <span className="hidden truncate font-semibold tracking-tight sm:inline">Chode Emporium Golf Pool</span>
        </Link>
        <HeaderAuth />
      </div>
    </header>
  );
}

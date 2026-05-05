import Image from "next/image";
import Link from "next/link";
import { HeaderAuth } from "@/components/header-auth";

export function Header() {
  return (
    <header className="border-b border-club-gold/25 bg-club-cream/50">
      <div className="container flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex min-w-0 shrink-0 items-center gap-3 text-club-navy">
          <Image
            src="/logo.png"
            alt="Chode Emporium Golf Pool crest"
            width={56}
            height={31}
            className="h-9 w-auto shrink-0 rounded-md border border-club-gold/40 bg-white object-contain shadow-sm"
            sizes="56px"
          />
          <span className="truncate font-semibold tracking-tight sm:inline">Chode Emporium Golf Pool</span>
        </Link>
        <HeaderAuth />
      </div>
    </header>
  );
}

import "./globals.css";
import type { Metadata } from "next";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "Chode Emporium Golf Pool",
  description: "Seven-tier picks, best four scores count, cut rule, and a winning-score tiebreaker."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main className="container py-8">{children}</main>
      </body>
    </html>
  );
}


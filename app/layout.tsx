import "./globals.css";
import type { Metadata } from "next";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "7-Tier Golf Pool Tracker",
  description: "Pick 1 golfer per tier. Best 4 scores count. MC rule enforced."
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


import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { UploadButton } from "@/components/UploadButton";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Finance",
  description: "Personal finance across DBS, CPF, YouTrip and Citibank",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/rules", label: "Rules" },
  { href: "/reconcile", label: "Reconcile" },
  { href: "/review", label: "Review" },
  { href: "/accounts", label: "Accounts" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Stamp the saved theme before first paint, so there is no flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`,
          }}
        />
      </head>
      <body>
        <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface-1)]">
          <div className="mx-auto flex max-w-7xl items-center gap-1 px-5 py-2.5">
            <Link href="/" className="mr-5 text-[13px] font-semibold tracking-tight">
              Finance
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded px-2.5 py-1 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <UploadButton />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
      </body>
    </html>
  );
}

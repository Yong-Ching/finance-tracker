import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { UploadButton } from "@/components/UploadButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CurrencyPicker } from "@/components/CurrencyPicker";
import { loadFx } from "@/lib/fx-server";

export const metadata: Metadata = {
  title: "Finance",
  description: "Personal finance across DBS, CPF, YouTrip and Citibank",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/rules", label: "Rules" },
  { href: "/reconcile", label: "Reconcile" },
  { href: "/review", label: "Review" },
  { href: "/accounts", label: "Accounts" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const fx = await loadFx();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Stamp the saved theme and figure hiding before first paint, so neither flashes. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);if(localStorage.getItem('figures')==='hidden')document.documentElement.setAttribute('data-figures','hidden')}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* A plain bar: the mark, the pages, the two actions. Its tone step from the page is the only separation. */}
        <header className="sticky top-0 z-40 bg-[var(--surface-1)]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1 px-5 py-2.5">
            <Link href="/" className="mr-3 flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.svg" alt="" width={22} height={22} />
              Finance
            </Link>
            {/* On a phone the pages take their own row and scroll inside it, never pushing the page sideways. */}
            <nav className="order-last -mx-2.5 flex w-[calc(100%+1.25rem)] min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:order-none md:mx-0 md:w-auto">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="shrink-0 rounded px-2.5 py-1 text-[14px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <CurrencyPicker fx={fx} />
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

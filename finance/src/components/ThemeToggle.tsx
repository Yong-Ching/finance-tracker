"use client";
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

/** Applied before paint by the inline script in layout.tsx; this keeps it in sync. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme((localStorage.getItem("theme") as Theme) ?? "system");
  }, []);

  const apply = (t: Theme) => {
    setTheme(t);
    try {
      if (t === "system") {
        localStorage.removeItem("theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("theme", t);
        document.documentElement.setAttribute("data-theme", t);
      }
    } catch {
      /* private browsing can throw on write; the page still renders correctly */
    }
  };

  return (
    <select
      value={theme}
      onChange={(e) => apply(e.target.value as Theme)}
      aria-label="Theme"
      className="rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[12px] text-[var(--text-secondary)]"
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}

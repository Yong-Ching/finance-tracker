"use client";
import { useSyncExternalStore } from "react";

/**
 * Hides every `.money` figure inside a `.hideable` region, for screen sharing.
 * The state lives on <html data-figures>, stamped before paint by layout.tsx;
 * CSS reads it to pick the icon, so there is no React state to fall out of sync.
 */
export function FiguresToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const hide = root.getAttribute("data-figures") !== "hidden";
    if (hide) root.setAttribute("data-figures", "hidden");
    else root.removeAttribute("data-figures");
    try {
      if (hide) localStorage.setItem("figures", "hidden");
      else localStorage.removeItem("figures");
    } catch {
      /* private browsing can throw on write; the toggle still works for this visit */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Hide or show figures"
      title="Hide or show figures"
      className="figures-toggle rounded border border-[var(--border)] bg-[var(--surface-1)] p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
    >
      <svg className="when-shown" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <svg className="when-hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="M3 3l18 18" />
      </svg>
    </button>
  );
}

const subscribe = (onChange: () => void) => {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-figures"] });
  return () => mo.disconnect();
};

/** For figures CSS cannot reach, such as chart text drawn in SVG. */
export function useFiguresHidden() {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.getAttribute("data-figures") === "hidden",
    () => false,
  );
}

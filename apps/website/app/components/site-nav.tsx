"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { BookOpen, Menu, X } from "lucide-react";
import { DOCS_URL, GITHUB_URL, NAV_SECTIONS } from "./sections";
import { GitHubIcon } from "./icons";

export function SiteNav() {
  const [active, setActive] = useState<string>(NAV_SECTIONS[0].id);
  const [menuOpen, setMenuOpen] = useState(false);

  // Scrollspy: highlight the nav link for the section currently in view.
  // `rootMargin` biases the active band toward the upper third of the viewport
  // so a section becomes "active" as its heading clears the sticky header.
  useEffect(() => {
    const sections = NAV_SECTIONS.map((s) =>
      document.getElementById(s.id),
    ).filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a
          href="#top"
          className="flex items-center gap-2 font-bold tracking-tight"
        >
          <Image
            src="/platypus.png"
            alt="Platypus logo"
            width={40}
            height={40}
            priority
            className="size-10"
          />
          <span className="text-lg">Platypus</span>
        </a>

        {/* Desktop anchor links */}
        <ul className="hidden items-center gap-1 md:flex">
          {NAV_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={active === section.id ? "true" : undefined}
                className={`rounded-md px-3 py-2 text-sm transition-colors hover:text-foreground ${
                  active === section.id
                    ? "text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <a
            href={DOCS_URL}
            className="hidden items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <BookOpen className="size-4" />
            Docs
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <GitHubIcon className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground md:hidden"
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="border-t border-border bg-background md:hidden">
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 sm:px-6">
            {NAV_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  onClick={() => setMenuOpen(false)}
                  className={`block rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent ${
                    active === section.id
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {section.label}
                </a>
              </li>
            ))}
            <li>
              <a
                href={DOCS_URL}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                <BookOpen className="size-4" />
                Docs
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}

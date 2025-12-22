'use client';

import dynamic from 'next/dynamic';
import { useAuth } from '@clerk/nextjs';
import { Search, Loader2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

// Dynamically import Clerk components to prevent SSR/hydration issues
const OrganizationSwitcher = dynamic(
  () => import('@clerk/nextjs').then((mod) => mod.OrganizationSwitcher),
  {
    ssr: false,
    loading: () => <div className="h-9 w-32 animate-pulse rounded-lg bg-muted" />,
  }
);

const UserButton = dynamic(
  () => import('@clerk/nextjs').then((mod) => mod.UserButton),
  {
    ssr: false,
    loading: () => <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />,
  }
);

export function Header() {
  const { isSignedIn } = useAuth();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-8 w-8 overflow-hidden rounded-lg">
                <Image
                  src="/logo.png"
                  alt="Signal"
                  width={32}
                  height={32}
                  className="h-8 w-8 object-cover object-[center_15%] scale-110"
                  unoptimized
                />
              </div>
              <span className="text-lg font-semibold text-[#F59E0B]">Signal</span>
            </Link>

            {/* Navigation links - only show when signed in */}
            {isSignedIn && (
              <nav className="flex items-center gap-4">
                <Link
                  href="/search"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Search className="h-4 w-4" />
                  Search
                </Link>
              </nav>
            )}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-4">
            {isSignedIn && (
              <>
                {/* Org Switcher */}
                <OrganizationSwitcher
                  hidePersonal
                  afterSelectOrganizationUrl="/search"
                  afterCreateOrganizationUrl="/search"
                  appearance={{
                    elements: {
                      rootBox: 'flex items-center',
                      organizationSwitcherTrigger:
                        'px-3 py-2 rounded-lg border border-border/50 hover:border-border bg-background/50 text-sm',
                    },
                  }}
                />

                {/* User Button */}
                <UserButton
                  afterSignOutUrl="/"
                  appearance={{
                    elements: {
                      avatarBox: 'h-8 w-8',
                    },
                  }}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

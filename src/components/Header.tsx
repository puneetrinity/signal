'use client';

import { OrganizationSwitcher, UserButton, useAuth } from '@clerk/nextjs';
import Image from 'next/image';
import Link from 'next/link';

export function Header() {
  const { isSignedIn } = useAuth();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
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

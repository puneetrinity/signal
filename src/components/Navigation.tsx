'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Home, Search, ClipboardCheck, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  {
    name: 'Home',
    href: '/',
    icon: Home,
  },
  {
    name: 'Search',
    href: '/search',
    icon: Search,
  },
  {
    name: 'Review',
    href: '/review',
    icon: ClipboardCheck,
  },
  {
    name: 'Sessions',
    href: '/sessions',
    icon: Activity,
  },
];

export function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 px-4 sm:px-6 lg:px-8 pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-7xl">
        <div className="relative flex h-20 items-center justify-between rounded-2xl border border-purple-500/20 bg-[#141428]/80 px-4 sm:px-6 lg:px-8 shadow-[0_12px_35px_-20px_rgba(139,92,246,0.5)] backdrop-blur-2xl backdrop-saturate-150 mt-4">
          <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-purple-500/10 via-transparent to-gold-500/10 opacity-80" />

          {/* Logo */}
          <div className="relative flex items-center gap-3">
            <Link
              href="/"
              className="pointer-events-auto hover:opacity-90 transition-opacity flex items-center gap-3"
            >
              <div className="h-9 w-9 overflow-hidden rounded-md">
                <Image
                  src="/logo.png"
                  alt="VantaHire"
                  width={40}
                  height={40}
                  className="h-10 w-10 object-cover object-top -mt-0.5"
                  priority
                  unoptimized
                />
              </div>
              <span className="text-lg font-semibold text-[#F59E0B]">Signal</span>
            </Link>
          </div>

          {/* Navigation Items */}
          <div className="relative flex items-center gap-1 pointer-events-auto">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 pointer-events-auto',
                    'hover:bg-purple-500/20',
                    isActive
                      ? 'text-white'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  {/* Active indicator - glass pill */}
                  {isActive && (
                    <div className="absolute inset-0 rounded-lg border border-purple-500/40 bg-purple-500/20 backdrop-blur-xl" />
                  )}

                  <Icon className="h-4 w-4 relative z-10" />
                  <span className="relative z-10 hidden sm:inline">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}

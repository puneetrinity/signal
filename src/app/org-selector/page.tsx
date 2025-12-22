'use client';

import dynamic from 'next/dynamic';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';

// Dynamically import OrganizationList to prevent SSR issues
const OrganizationList = dynamic(
  () => import('@clerk/nextjs').then((mod) => mod.OrganizationList),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

export default function OrgSelectorPage() {
  const { orgId } = useAuth();
  const router = useRouter();

  // If user already has an org selected, redirect to search
  useEffect(() => {
    if (orgId) {
      router.push('/search');
    }
  }, [orgId, router]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold mb-2">Select Your Organization</h1>
        <p className="text-muted-foreground">
          Choose an existing organization or create a new one to get started.
        </p>
      </div>

      <OrganizationList
        hidePersonal
        afterSelectOrganizationUrl="/search"
        afterCreateOrganizationUrl="/search"
        appearance={{
          elements: {
            rootBox: 'mx-auto',
            card: 'bg-card border border-border shadow-lg',
          },
        }}
      />
    </div>
  );
}

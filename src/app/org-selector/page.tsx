'use client';

import { OrganizationList, useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

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

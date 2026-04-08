import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 text-center">
        <h1 className="text-2xl font-bold mb-4">Authentication Disabled</h1>
        <p className="text-muted-foreground">
          Clerk is not configured. The app is running in API-only mode (v3). 
          The frontend UI requires Clerk keys to function properly.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <SignIn
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

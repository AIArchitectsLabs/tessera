import { Button } from "@/components/ui/button";
import { Blocks, CheckCircle2, KeyRound, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";

interface LoginViewProps {
  onAuthenticate: () => Promise<void>;
  statusMessage?: string | null;
}

export function LoginView({ onAuthenticate, statusMessage }: LoginViewProps) {
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAuthenticate() {
    setAuthenticating(true);
    setError(null);
    try {
      await onAuthenticate();
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setAuthenticating(false);
    }
  }

  return (
    <main className="min-h-screen w-screen overflow-hidden bg-[var(--paper)] text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[1.06fr_0.94fr]">
        <section className="relative flex min-h-[52vh] flex-col justify-between overflow-hidden border-b border-border bg-[var(--desk)] px-6 py-7 sm:px-10 lg:min-h-screen lg:border-b-0 lg:border-r lg:px-12">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--sun)_18%,transparent),transparent_36%),linear-gradient(155deg,transparent_46%,color-mix(in_oklab,var(--leaf)_14%,transparent))]" />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(to_top,color-mix(in_oklab,var(--ink)_8%,transparent),transparent)]" />

          <div className="relative flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--ink)] text-[var(--paper)] shadow-sm">
              <Blocks size={22} strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-base font-bold tracking-tight">Tessera</div>
              <div className="text-xs font-medium text-muted-foreground">Agent workspace</div>
            </div>
          </div>

          <div className="relative my-12 max-w-2xl lg:my-0">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur">
              <Sparkles size={14} className="text-[var(--sun)]" />
              Business work, beautifully coordinated
            </div>
            <h1 className="max-w-2xl text-4xl font-bold leading-[1.04] tracking-normal text-foreground sm:text-5xl lg:text-6xl">
              Bring your workday into one focused place.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Sign in to Tessera and enter a calm desktop workspace for tasks, playbooks, inbox
              decisions, and agent-assisted delivery.
            </p>
          </div>

          <div className="relative grid gap-3 border-t border-border pt-6 sm:grid-cols-3">
            <TrustPoint
              icon={<CheckCircle2 size={17} />}
              title="Task clarity"
              body="Plan and track work without losing context."
            />
            <TrustPoint
              icon={<ShieldCheck size={17} />}
              title="Local first"
              body="Desktop session state stays on this machine."
            />
            <TrustPoint
              icon={<KeyRound size={17} />}
              title="Google sign-in"
              body="Use your Google account to enter Tessera."
            />
          </div>
        </section>

        <section className="flex min-h-[48vh] items-center justify-center bg-background px-6 py-10 sm:px-10 lg:min-h-screen">
          <div className="w-full max-w-md">
            <div className="rounded-xl border border-border bg-card p-6 shadow-[0_24px_80px_color-mix(in_oklab,var(--ink)_12%,transparent)] sm:p-8">
              <div className="mb-7 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--sun-soft)] text-[var(--ink)]">
                  <ShieldCheck size={24} />
                </div>
                <h2 className="text-2xl font-bold tracking-normal text-foreground">
                  Welcome to Tessera
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Continue with Google to unlock your workspace.
                </p>
              </div>

              <div className="mb-5 rounded-lg border border-[color-mix(in_oklab,var(--sun)_42%,var(--divider))] bg-[var(--sun-soft)] px-4 py-3 text-center text-sm font-semibold text-foreground">
                {authenticating && statusMessage
                  ? statusMessage
                  : "Your dashboard opens after authentication"}
              </div>

              <Button
                type="button"
                className="h-12 w-full rounded-lg bg-foreground text-background hover:bg-foreground/90"
                disabled={authenticating}
                onClick={handleAuthenticate}
              >
                {authenticating ? <Loader2 size={18} className="animate-spin" /> : <GoogleMark />}
                {authenticating ? "Authenticating..." : "Continue with Google"}
              </Button>

              {error && (
                <div className="mt-4 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="mt-7 border-t border-border pt-5">
                <div className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                  Secure authentication
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs font-medium text-muted-foreground">
                  <div className="flex items-center justify-center gap-1.5 rounded-md bg-secondary px-2 py-2">
                    <ShieldCheck size={14} className="text-[var(--leaf)]" />
                    Local session
                  </div>
                  <div className="flex items-center justify-center gap-1.5 rounded-md bg-secondary px-2 py-2">
                    <CheckCircle2 size={14} className="text-[var(--leaf)]" />
                    Secret-free UI
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function TrustPoint({
  body,
  icon,
  title,
}: {
  body: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/70 p-3 shadow-sm backdrop-blur">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="text-[var(--sun)]">{icon}</span>
        {title}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

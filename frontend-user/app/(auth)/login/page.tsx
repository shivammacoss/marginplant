"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { ApiError, ProfileAPI, setTokens } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InstallPwaButton } from "@/components/common/InstallPwaButton";

const schema = z.object({
  identifier: z.string().min(3, "Enter your email or mobile"),
  password: z.string().min(8, "Minimum 8 characters"),
  two_fa_code: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

// Next.js 14 bails out of static generation whenever a page uses
// `useSearchParams()` without a Suspense boundary — building this file
// then errors with "useSearchParams() should be wrapped in a suspense
// boundary at page /login". Wrapping the inner client component in
// <Suspense> lets the rest of the page prerender normally while the
// search-param-dependent bit becomes a CSR island.
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSplash subtitle="Loading…" />}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginSplash({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center">
      <Loader2 className="size-6 animate-spin text-primary" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Signing you in…</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useAuthStore((s) => s.login);
  const setUser = useAuthStore((s) => s.setUser);
  const hydrated = useAuthStore((s) => s.hydrated);
  const currentUser = useAuthStore((s) => s.user);
  const [showPwd, setShowPwd] = useState(false);
  const [needs2fa, setNeeds2fa] = useState(false);

  // If the auth store rehydrated with a live `user`, the visitor is
  // already signed in — bounce them to /dashboard instead of showing
  // the login form. Critical for the installed PWA: cold launches land
  // here from the manifest's start_url, and without this guard a
  // previously-authed user would see the login form even though their
  // 30-day refresh token is still valid (user complaint: "ek baar
  // login ho gaya use to login hi rahe, logout mat ho").
  useEffect(() => {
    if (hydrated && currentUser) {
      router.replace("/dashboard");
    }
  }, [hydrated, currentUser, router]);

  // Detect admin "Login as user" on the FIRST render — the access + refresh
  // tokens come in as query params when the admin panel pops a new tab via
  // `window.open(/login?access=…&refresh=…#impersonate)`. Reading them from
  // useSearchParams() during render (instead of waiting for an effect)
  // lets us hide the login form before it can paint — without it the user
  // saw the entire form for a beat before the redirect fired. Picking up
  // SSR with useSearchParams is hydration-safe in Next.js App Router.
  const impAccess = searchParams?.get("access");
  const impRefresh = searchParams?.get("refresh");
  const isImpersonating = !!(impAccess && impRefresh);
  const [impersonationFailed, setImpersonationFailed] = useState(false);

  useEffect(() => {
    if (!isImpersonating || !impAccess || !impRefresh) return;
    setTokens(impAccess, impRefresh);
    // Warm the /dashboard route bundle in parallel with the ProfileAPI.me
    // round-trip — without it Next.js loads the dashboard's JS chunks
    // AFTER the redirect fires, adding another network beat where the
    // user sees nothing. Prefetching here means the moment setUser +
    // router.replace runs, the dashboard paints from cache.
    router.prefetch("/dashboard");
    ProfileAPI.me()
      .then((u: any) => {
        setUser(u as any);
        // Quiet success — no toast — so the impersonation handoff feels
        // like a seamless route change rather than a "logged in" event.
        // The previous toast hung around for 4s on the dashboard which
        // felt jarring after the splash already said "Signing you in".
        router.replace("/dashboard");
      })
      .catch(() => {
        toast.error("Impersonation token rejected");
        setImpersonationFailed(true);
      });
  }, [isImpersonating, impAccess, impRefresh, router, setUser]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: "", password: "", two_fa_code: "" },
  });

  async function onSubmit(values: FormValues) {
    try {
      await login(values.identifier, values.password, values.two_fa_code || undefined);
      toast.success("Welcome back");
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "TWO_FA_REQUIRED") {
          setNeeds2fa(true);
          toast.info("Enter your 2FA code to continue");
          return;
        }
        toast.error(err.message);
      } else {
        toast.error("Login failed. Please try again.");
      }
    }
  }

  // When admin pops this tab with impersonation tokens, replace the entire
  // login UI with a "Signing in…" splash so the user never sees the form.
  // The effect above completes the handoff and redirects to the dashboard.
  // If the token is rejected we fall back to the normal form below so the
  // user can sign in manually.
  if (isImpersonating && !impersonationFailed) {
    return <LoginSplash subtitle="Redirecting to your dashboard" />;
  }

  // Pre-hydration: zustand `persist` reads localStorage on mount. Until
  // `hydrated` flips true we don't yet know if there's a saved session.
  // Rendering the login form during this 200-500 ms window is what made
  // returning PWA users see a flash of "Sign in" before they're bounced
  // to /dashboard (user complaint: "jab bhi login karta hu, 500 ms ke
  // liye har baar login screen dikhti hai"). Showing the same splash
  // covers the gap — once hydration completes EITHER the redirect
  // effect above fires (authed) OR the form renders (truly logged out).
  if (!hydrated) {
    return <LoginSplash subtitle="Restoring your session…" />;
  }
  // Hydrated AND we found a user → redirect effect above is already
  // firing; render the splash (NOT the form) during that one extra
  // frame so the login UI never paints for an authed user.
  if (currentUser) {
    return <LoginSplash subtitle="Redirecting to your dashboard" />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
        <p className="text-sm text-muted-foreground">Welcome back. Enter your credentials below.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="identifier">Email or Mobile</Label>
          <Input
            id="identifier"
            placeholder="you@example.com or 9999900000"
            autoComplete="username"
            {...form.register("identifier")}
          />
          {form.formState.errors.identifier && (
            <p className="text-xs text-destructive">{form.formState.errors.identifier.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPwd ? "text" : "password"}
              autoComplete="current-password"
              {...form.register("password")}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPwd((v) => !v)}
              aria-label={showPwd ? "Hide password" : "Show password"}
            >
              {showPwd ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        {needs2fa && (
          <div className="space-y-2">
            <Label htmlFor="two_fa_code">2FA Code</Label>
            <Input
              id="two_fa_code"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              autoComplete="one-time-code"
              {...form.register("two_fa_code")}
            />
          </div>
        )}

        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-primary hover:underline">
          Create one
        </Link>
      </p>

      {/* PWA "Install app" affordance — only shows on browsers that
          support installation AND when the user hasn't already
          installed. On iOS Safari (no beforeinstallprompt) it renders
          a hint with the manual Share → Add to Home Screen path
          instead. Invisible inside the installed standalone shell. */}
      <div className="flex justify-center">
        <InstallPwaButton variant="compact" />
      </div>
    </div>
  );
}

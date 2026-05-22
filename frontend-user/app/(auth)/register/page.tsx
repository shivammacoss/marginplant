"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { AuthAPI, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const schema = z.object({
  full_name: z.string().min(2, "Enter your full name").max(128),
  email: z.string().email("Invalid email"),
  mobile: z
    .string()
    .regex(/^[6-9]\d{9}$/, "10-digit Indian mobile starting 6/7/8/9"),
  pan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Invalid PAN format")
    .optional()
    .or(z.literal("")),
  password: z
    .string()
    .min(8, "Minimum 8 characters")
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[a-z]/, "Must contain a lowercase letter")
    .regex(/\d/, "Must contain a digit")
    .regex(/[^A-Za-z0-9]/, "Must contain a special character (e.g. @, #, $)"),
});
type FormValues = z.infer<typeof schema>;

// Five visible rules — match the zod schema exactly so what the user
// sees ticking off is what actually validates server-side.
const PWD_RULES = [
  { id: "len",   label: "At least 8 characters",       test: (s: string) => s.length >= 8 },
  { id: "upper", label: "One uppercase letter (A–Z)",  test: (s: string) => /[A-Z]/.test(s) },
  { id: "lower", label: "One lowercase letter (a–z)",  test: (s: string) => /[a-z]/.test(s) },
  { id: "digit", label: "One number (0–9)",            test: (s: string) => /\d/.test(s) },
  { id: "spec",  label: "One special character (@, #, $…)", test: (s: string) => /[^A-Za-z0-9]/.test(s) },
];

type Strength = {
  score: number;
  label: string;
  chipClass: string;
  barClass: string;
};

function passwordStrength(pwd: string): Strength {
  const score = PWD_RULES.reduce((n, r) => n + (r.test(pwd) ? 1 : 0), 0);
  if (!pwd) {
    return { score: 0, label: "", chipClass: "", barClass: "bg-muted" };
  }
  if (score <= 2) {
    return {
      score,
      label: "Weak",
      chipClass: "bg-sell/15 text-sell ring-1 ring-sell/30",
      barClass: "bg-sell",
    };
  }
  if (score <= 4) {
    return {
      score,
      label: "Medium",
      chipClass: "bg-atm/20 text-atm ring-1 ring-atm/40",
      barClass: "bg-atm",
    };
  }
  return {
    score,
    label: "Strong",
    chipClass: "bg-buy/15 text-buy ring-1 ring-buy/30",
    barClass: "bg-buy",
  };
}

// Wraps the inner client component in <Suspense> because Next 14's
// `useSearchParams()` requires a Suspense boundary in the page tree.
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // White-label referral attribution — admin-A sends a prospect to
  // marginplant.com/register?ref=ADM12345678. We forward this as
  // `referral_code` to the backend, which resolves it to the admin's
  // id and stamps `assigned_admin_id` + `signup_origin=BRANDED_REFERRAL`
  // on the new user. Empty / missing is the pre-rollout default
  // (super-admin pool, signup_origin=PLATFORM).
  const refCode = (searchParams?.get("ref") || "").trim().toUpperCase();
  const [showPwd, setShowPwd] = useState(false);
  const [pwdFocused, setPwdFocused] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: "", email: "", mobile: "", pan: "", password: "" },
    mode: "onChange",
  });

  const pwd = form.watch("password") || "";
  const strength = passwordStrength(pwd);
  const showRules = pwdFocused || pwd.length > 0;

  async function onSubmit(values: FormValues) {
    try {
      await AuthAPI.register({
        full_name: values.full_name,
        email: values.email,
        mobile: values.mobile,
        pan: values.pan || undefined,
        password: values.password,
        // Forward `?ref=` as referral_code so the backend can attribute
        // this signup to the admin who shared the link. Undefined when
        // missing → backend treats as PLATFORM signup.
        referral_code: refCode || undefined,
      });
      toast.success("Account created. Please sign in.");
      // Preserve the ref on the way to /login so the BrandingProvider
      // there can keep showing the admin's brand (otherwise the user
      // would see platform branding for one tick).
      router.push(refCode ? `/login?ref=${encodeURIComponent(refCode)}` : "/login");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Registration failed";
      toast.error(msg);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Create account</h2>
        <p className="text-sm text-muted-foreground">Open your trading account in 60 seconds.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="full_name">Full name</Label>
          <Input id="full_name" placeholder="Rohan Sharma" autoComplete="name" {...form.register("full_name")} />
          {form.formState.errors.full_name && (
            <p className="text-xs text-destructive">{form.formState.errors.full_name.message}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" autoComplete="email" {...form.register("email")} />
            {form.formState.errors.email && (
              <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mobile">Mobile</Label>
            <Input id="mobile" inputMode="numeric" maxLength={10} autoComplete="tel" placeholder="9999900000" {...form.register("mobile")} />
            {form.formState.errors.mobile && (
              <p className="text-xs text-destructive">{form.formState.errors.mobile.message}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pan">PAN (optional)</Label>
          <Input
            id="pan"
            placeholder="ABCDE1234F"
            maxLength={10}
            className="uppercase"
            {...form.register("pan", {
              onChange: (e) => (e.target.value = e.target.value.toUpperCase()),
            })}
          />
          {form.formState.errors.pan && (
            <p className="text-xs text-destructive">{form.formState.errors.pan.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            {pwd && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                  strength.chipClass,
                )}
              >
                {strength.label}
              </span>
            )}
          </div>

          <div className="relative">
            <Input
              id="password"
              type={showPwd ? "text" : "password"}
              placeholder="e.g. Abc@1234"
              autoComplete="new-password"
              className="pr-10"
              {...form.register("password", {
                onBlur: () => setPwdFocused(false),
              })}
              onFocus={() => setPwdFocused(true)}
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              aria-label={showPwd ? "Hide password" : "Show password"}
              aria-pressed={showPwd}
              tabIndex={-1}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPwd ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {/* Segmented strength bar — 5 bars, fills left-to-right as rules satisfy */}
          <div className="flex gap-1.5" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors duration-300",
                  i < strength.score ? strength.barClass : "bg-muted",
                )}
              />
            ))}
          </div>

          {/* Live rules checklist */}
          {showRules && (
            <ul
              className="grid grid-cols-1 gap-1.5 rounded-md border border-border bg-card/60 p-3 sm:grid-cols-2"
              aria-live="polite"
            >
              {PWD_RULES.map((r) => {
                const ok = r.test(pwd);
                return (
                  <li
                    key={r.id}
                    className={cn(
                      "flex items-center gap-2 text-xs transition-colors",
                      ok ? "text-buy" : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full",
                        ok ? "bg-buy/15" : "bg-muted",
                      )}
                    >
                      {ok ? (
                        <Check className="size-2.5" strokeWidth={3} />
                      ) : (
                        <X className="size-2.5 text-muted-foreground" strokeWidth={3} />
                      )}
                    </span>
                    <span>{r.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {form.formState.errors.password && !showRules && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";

// This page creates regular trading users (CLIENT). Sub-admins are minted
// from /management/sub-admins (super-admin only) — role is therefore not
// exposed here.
const schema = z
  .object({
    full_name: z.string().min(2),
    email: z.string().email(),
    mobile: z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile"),
    password: z.string().min(8),
    // Confirmation field — added after a sub-admin typo'd the initial
    // password (Prachi / 18-May-2026) and the new user couldn't log in.
    // Backend never gets this field; the schema-level `refine` below
    // catches the mismatch client-side before submit.
    confirm_password: z.string().min(8),
    is_demo: z.boolean(),
    initial_balance: z.coerce.number().min(0).default(0),
    credit_limit: z.coerce.number().min(0).default(0),
    pan: z.string().optional(),
  })
  .refine((v) => v.password === v.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords don't match",
  });
type Values = z.infer<typeof schema>;

export default function NewUserPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: "",
      email: "",
      mobile: "",
      password: "",
      confirm_password: "",
      is_demo: false,
      initial_balance: 0,
      credit_limit: 0,
      pan: "",
    },
  });

  async function onSubmit(v: Values) {
    // confirm_password is a client-only guard — strip before the POST so
    // the backend's CreateUserRequest schema (which doesn't know about
    // this field) doesn't reject the request as `extra=forbid`.
    const { confirm_password: _confirm, ...payload } = v;
    void _confirm;
    try {
      const created = await UsersAPI.create({ ...payload, role: "CLIENT" });
      toast.success(`Created ${created.user_code}`);
      router.push(`/users/${created.id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create user" description="Provision a new account. Segment overrides can be set per-user from the Users list." />

      <form onSubmit={form.handleSubmit(onSubmit)} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
            <CardDescription>Identity + login</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Full name" error={form.formState.errors.full_name?.message}>
              <Input {...form.register("full_name")} />
            </Field>
            <Field label="Email" error={form.formState.errors.email?.message}>
              <Input type="email" {...form.register("email")} />
            </Field>
            <Field label="Mobile" error={form.formState.errors.mobile?.message}>
              <Input maxLength={10} {...form.register("mobile")} />
            </Field>
            <Field label="Initial password" error={form.formState.errors.password?.message}>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  className="pr-10"
                  {...form.register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Field
              label="Confirm password"
              error={form.formState.errors.confirm_password?.message}
            >
              <Input
                type={showPassword ? "text" : "password"}
                {...form.register("confirm_password")}
              />
            </Field>
            <Field label="PAN (optional)">
              <Input className="uppercase" maxLength={10} {...form.register("pan")} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Access &amp; balances</CardTitle>
            <CardDescription>Opening balance + credit limit</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Initial balance (₹)">
              <Input type="number" step="0.01" {...form.register("initial_balance")} />
            </Field>
            <Field label="Credit limit (₹)">
              <Input type="number" step="0.01" {...form.register("credit_limit")} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...form.register("is_demo")} className="size-4 accent-primary" />
              Demo account (no real money)
            </label>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2 lg:col-span-2">
          <Button variant="outline" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" loading={form.formState.isSubmitting}>
            Create user
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

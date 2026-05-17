"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AuthAPI, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const requestSchema = z.object({ identifier: z.string().min(3) });
const resetSchema = z.object({
  identifier: z.string().min(3),
  otp: z.string().min(4).max(8),
  new_password: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/\d/),
});

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<"request" | "reset">("request");
  const [identifier, setIdentifier] = useState("");

  const requestForm = useForm({ resolver: zodResolver(requestSchema), defaultValues: { identifier: "" } });
  const resetForm = useForm({
    resolver: zodResolver(resetSchema),
    defaultValues: { identifier: "", otp: "", new_password: "" },
  });

  async function onRequest(v: { identifier: string }) {
    try {
      await AuthAPI.forgotPassword(v.identifier);
      toast.success("If the account exists, a reset code was sent.");
      setIdentifier(v.identifier);
      resetForm.setValue("identifier", v.identifier);
      setStep("reset");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send reset code");
    }
  }

  async function onReset(v: { identifier: string; otp: string; new_password: string }) {
    try {
      await AuthAPI.resetPassword(v);
      toast.success("Password updated. Please sign in.");
      window.location.href = "/login";
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Reset failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Forgot password</h2>
        <p className="text-sm text-muted-foreground">
          {step === "request"
            ? "Enter your email or mobile and we'll send a reset code."
            : `Enter the code sent to ${identifier} and choose a new password.`}
        </p>
      </div>

      {step === "request" ? (
        <form onSubmit={requestForm.handleSubmit(onRequest)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifier">Email or Mobile</Label>
            <Input id="identifier" {...requestForm.register("identifier")} />
          </div>
          <Button type="submit" className="w-full" loading={requestForm.formState.isSubmitting}>
            Send code
          </Button>
        </form>
      ) : (
        <form onSubmit={resetForm.handleSubmit(onReset)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="otp">Reset code</Label>
            <Input id="otp" inputMode="numeric" maxLength={6} {...resetForm.register("otp")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new_password">New password</Label>
            <Input id="new_password" type="password" {...resetForm.register("new_password")} />
          </div>
          <Button type="submit" className="w-full" loading={resetForm.formState.isSubmitting}>
            Reset password
          </Button>
        </form>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Remember it?{" "}
        <Link href="/login" className="text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

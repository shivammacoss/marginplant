"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AuthAPI, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function TwoFAEnrollPage() {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await AuthAPI.twoFASetup();
        setSecret(r.secret);
        setUri(r.provisioning_uri);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Could not start 2FA setup");
      }
    })();
  }, []);

  async function enable() {
    setBusy(true);
    try {
      await AuthAPI.twoFAEnable(code);
      toast.success("Two-factor authentication enabled");
      router.push("/profile");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enable two-factor authentication</CardTitle>
        <CardDescription>
          Scan the secret with Google Authenticator, Authy, or 1Password and enter the 6-digit code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {secret ? (
          <>
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <div className="text-xs uppercase text-muted-foreground">Secret</div>
              <div className="break-all font-mono text-xs">{secret}</div>
              {uri && (
                <>
                  <div className="mt-2 text-xs uppercase text-muted-foreground">Provisioning URI</div>
                  <div className="break-all font-mono text-xs">{uri}</div>
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">6-digit code</Label>
              <Input
                id="code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <Button onClick={enable} className="w-full" loading={busy} disabled={code.length !== 6}>
              Verify &amp; enable
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Generating secret…</p>
        )}
      </CardContent>
    </Card>
  );
}

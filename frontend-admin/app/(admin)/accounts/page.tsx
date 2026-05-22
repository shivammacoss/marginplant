"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { PayinOutAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageHeader } from "@/components/common/PageHeader";
import { WdRulesPanel } from "@/components/admin/payments/WdRulesPanel";

export default function AdminAccountsPage() {
  const qc = useQueryClient();
  const { data: banks } = useQuery({ queryKey: ["admin", "banks"], queryFn: () => PayinOutAPI.bankAccounts() });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    bank_name: "",
    account_holder: "",
    account_number: "",
    ifsc_code: "",
    upi_id: "",
    is_active: true,
    is_default: false,
  });

  async function add() {
    try {
      await PayinOutAPI.createBank(form);
      toast.success("Added");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["admin", "banks"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this company bank?")) return;
    try {
      await PayinOutAPI.deleteBank(id);
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["admin", "banks"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Company accounts & W/D rules"
        description="Bank accounts where users deposit + minimum/maximum/auto-approve rules."
        actions={
          <Dialog open={adding} onOpenChange={setAdding}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" /> Add bank
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add company bank</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                {(["bank_name", "account_holder", "account_number", "ifsc_code", "upi_id"] as const).map((k) => (
                  <div key={k} className="space-y-1.5">
                    <Label className="capitalize">{k.replace("_", " ")}</Label>
                    <Input
                      value={(form as any)[k]}
                      onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    />
                  </div>
                ))}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                    className="size-4 accent-primary"
                  />
                  Default
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button onClick={add}>Add</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <section className="space-y-2">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground">Company bank accounts</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {banks?.map((b: any) => (
            <Card key={b.id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle>{b.bank_name}</CardTitle>
                  <CardDescription>
                    {b.account_holder} · {b.account_number} · {b.ifsc_code}
                  </CardDescription>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(b.id)} aria-label="Delete">
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                <div>UPI: {b.upi_id || "—"}</div>
                <div>{b.is_default ? "Default" : "Secondary"}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
          Deposit / withdrawal rules
        </h2>
        <WdRulesPanel />
      </section>
    </div>
  );
}

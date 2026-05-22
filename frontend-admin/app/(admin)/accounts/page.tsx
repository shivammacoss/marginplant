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

export default function AdminAccountsPage() {
  const qc = useQueryClient();
  const { data: banks } = useQuery({ queryKey: ["admin", "banks"], queryFn: () => PayinOutAPI.bankAccounts() });
  const { data: rules } = useQuery({ queryKey: ["admin", "wd-rules"], queryFn: () => PayinOutAPI.wdRules() });

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

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
              Deposit / withdrawal rules
            </h2>
            <p className="text-xs text-muted-foreground">
              {rules?.tier === "super_admin"
                ? "Super-admin pool — applies to your direct users + cascades into admin / broker pools below."
                : rules?.tier === "admin"
                  ? "Your admin pool — applies to users you own. Field left blank → inherits from super-admin."
                  : rules?.tier === "broker"
                    ? "Your broker pool — applies to users in your sub-tree. Field left blank → inherits from your admin / super-admin."
                    : "Editor — set rules for your own user pool."}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rules?.rules?.map((r) => (
            <WdRuleCard key={r.rule_type} rule={r} />
          ))}
        </div>
      </section>
    </div>
  );
}

type RuleFields = {
  min_amount: string | null;
  max_amount: string | null;
  daily_limit: string | null;
  allowed_days: number[] | null;
  allowed_times: { start: string; end: string }[] | null;
  charges_flat: string | null;
  charges_percent: number | null;
  auto_approve_under: string | null;
  mandatory_remark: boolean | null;
};

const WEEKDAYS = [
  { i: 0, label: "Mon" },
  { i: 1, label: "Tue" },
  { i: 2, label: "Wed" },
  { i: 3, label: "Thu" },
  { i: 4, label: "Fri" },
  { i: 5, label: "Sat" },
  { i: 6, label: "Sun" },
];

function WdRuleCard({
  rule,
}: {
  rule: {
    rule_type: "DEPOSIT" | "WITHDRAWAL";
    own: any;
    effective: any;
    sources: Record<string, string>;
  };
}) {
  const qc = useQueryClient();
  // Form seeds from the caller's OWN tier values. Blanks here represent
  // "I'm not overriding this field — let it inherit from the layer below".
  // The effective panel on the right shows what the user will actually
  // get + which tier provided each value.
  const [form, setForm] = useState<RuleFields>(() => normaliseOwn(rule.own));
  const [saving, setSaving] = useState(false);

  function normaliseOwn(o: any): RuleFields {
    return {
      min_amount: o?.min_amount ?? null,
      max_amount: o?.max_amount ?? null,
      daily_limit: o?.daily_limit ?? null,
      allowed_days: Array.isArray(o?.allowed_days) ? o.allowed_days : null,
      allowed_times: Array.isArray(o?.allowed_times) ? o.allowed_times : null,
      charges_flat: o?.charges_flat ?? null,
      charges_percent: o?.charges_percent ?? null,
      auto_approve_under: o?.auto_approve_under ?? null,
      mandatory_remark: o?.mandatory_remark ?? null,
    };
  }

  function toggleDay(i: number) {
    const current = form.allowed_days ?? rule.effective.allowed_days ?? [0, 1, 2, 3, 4, 5, 6];
    const next = current.includes(i)
      ? current.filter((d: number) => d !== i)
      : [...current, i].sort();
    setForm((f) => ({ ...f, allowed_days: next }));
  }

  function setTimeWindow(start: string, end: string) {
    setForm((f) => ({ ...f, allowed_times: [{ start, end }] }));
  }

  async function save() {
    setSaving(true);
    try {
      // Send only fields the admin actually filled. Empty strings → null
      // (clears the override at this tier). Numbers parsed back from
      // string inputs. The backend coerces sparse payloads correctly.
      const payload: Record<string, any> = {};
      const moneyFields = ["min_amount", "max_amount", "daily_limit", "charges_flat", "auto_approve_under"] as const;
      for (const f of moneyFields) {
        const v = form[f];
        if (v === "" || v === null) payload[f] = null;
        else payload[f] = String(v);
      }
      if (form.charges_percent === null) payload.charges_percent = null;
      else payload.charges_percent = Number(form.charges_percent);
      payload.mandatory_remark = form.mandatory_remark;
      payload.allowed_days = form.allowed_days;
      payload.allowed_times = form.allowed_times;

      await PayinOutAPI.updateWdRule(rule.rule_type, payload);
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["admin", "wd-rules"] });
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const effActiveDays: number[] = rule.effective.allowed_days ?? [0, 1, 2, 3, 4, 5, 6];
  const formActiveDays: number[] = form.allowed_days ?? effActiveDays;
  const effTime = rule.effective.allowed_times?.[0] ?? { start: "09:00", end: "21:00" };
  const formTime = form.allowed_times?.[0] ?? null;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{rule.rule_type}</CardTitle>
        <CardDescription className="text-xs">
          Blanks inherit from the layer below — leave a field empty if you don't want to override it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <RuleInput
            label="Min amount (₹)"
            value={form.min_amount}
            hint={inheritHint(rule, "min_amount", `₹${rule.effective.min_amount ?? 0}`)}
            onChange={(v) => setForm((f) => ({ ...f, min_amount: v }))}
          />
          <RuleInput
            label="Max amount (₹)"
            value={form.max_amount}
            hint={inheritHint(rule, "max_amount", `₹${rule.effective.max_amount ?? 0}`)}
            onChange={(v) => setForm((f) => ({ ...f, max_amount: v }))}
          />
          <RuleInput
            label="Daily limit (₹)"
            value={form.daily_limit}
            hint={inheritHint(rule, "daily_limit", `₹${rule.effective.daily_limit ?? 0}`)}
            onChange={(v) => setForm((f) => ({ ...f, daily_limit: v }))}
          />
          <RuleInput
            label="Auto-approve under (₹)"
            value={form.auto_approve_under}
            hint={inheritHint(rule, "auto_approve_under", `₹${rule.effective.auto_approve_under ?? 0}`)}
            onChange={(v) => setForm((f) => ({ ...f, auto_approve_under: v }))}
          />
          <RuleInput
            label="Flat charge (₹)"
            value={form.charges_flat}
            hint={inheritHint(rule, "charges_flat", `₹${rule.effective.charges_flat ?? 0}`)}
            onChange={(v) => setForm((f) => ({ ...f, charges_flat: v }))}
          />
          <RuleInput
            label="Charge %"
            value={form.charges_percent === null ? null : String(form.charges_percent)}
            hint={inheritHint(rule, "charges_percent", `${rule.effective.charges_percent ?? 0}%`)}
            onChange={(v) =>
              setForm((f) => ({
                ...f,
                charges_percent: v === null || v === "" ? null : Number(v),
              }))
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Allowed days</Label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => {
              const active = formActiveDays.includes(d.i);
              const editing = form.allowed_days !== null;
              return (
                <button
                  key={d.i}
                  type="button"
                  onClick={() => toggleDay(d.i)}
                  className={
                    "rounded px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset transition-colors " +
                    (active
                      ? "bg-primary/15 text-primary ring-primary/30"
                      : "bg-muted/30 text-muted-foreground ring-border")
                  }
                >
                  {d.label}
                </button>
              );
            })}
            {form.allowed_days !== null && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, allowed_days: null }))}
                className="rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:underline"
              >
                Reset to inherit
              </button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {form.allowed_days === null
              ? `Inheriting from ${rule.sources.allowed_days || "default"} — currently ${formatDays(effActiveDays)}`
              : `Will save: ${formatDays(formActiveDays)}`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Allowed time window (IST)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="time"
              value={formTime?.start ?? effTime.start}
              onChange={(e) => setTimeWindow(e.target.value, formTime?.end ?? effTime.end)}
              className="h-8 w-28 text-xs"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              type="time"
              value={formTime?.end ?? effTime.end}
              onChange={(e) => setTimeWindow(formTime?.start ?? effTime.start, e.target.value)}
              className="h-8 w-28 text-xs"
            />
            {formTime !== null && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, allowed_times: null }))}
                className="text-[11px] text-muted-foreground hover:underline"
              >
                Reset to inherit
              </button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {formTime === null
              ? `Inheriting from ${rule.sources.allowed_times || "default"} — currently ${effTime.start}–${effTime.end}`
              : `Will save: ${formTime.start}–${formTime.end}`}
          </p>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={
              form.mandatory_remark === null
                ? !!rule.effective.mandatory_remark
                : !!form.mandatory_remark
            }
            onChange={(e) => setForm((f) => ({ ...f, mandatory_remark: e.target.checked }))}
            className="size-4 accent-primary"
          />
          <span>Mandatory remark from user</span>
          {form.mandatory_remark === null && (
            <span className="text-[10px] text-muted-foreground">
              (inherited from {rule.sources.mandatory_remark || "default"})
            </span>
          )}
        </label>

        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={save} loading={saving} disabled={saving}>
            Save {rule.rule_type.toLowerCase()} rules
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RuleInput({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string | null;
  hint: string;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="text"
        inputMode="decimal"
        value={value ?? ""}
        placeholder={hint}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="h-8 text-xs"
      />
    </div>
  );
}

function inheritHint(
  rule: { sources: Record<string, string> },
  field: string,
  effectiveLabel: string,
): string {
  const src = rule.sources[field] || "default";
  if (src === "broker" || src === "admin" || src === "super_admin" || src === "global") {
    return `inherits ${effectiveLabel} from ${src}`;
  }
  return effectiveLabel;
}

function formatDays(days: number[]): string {
  if (!days.length) return "none";
  if (days.length === 7) return "All days";
  return days.map((d) => WEEKDAYS[d]?.label).filter(Boolean).join(", ");
}

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PayinOutAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Tier-aware deposit / withdrawal rules editor. Operator's 22-May spec:
// "super admin apne user ke liye, admin apne user ke liye, broker apne
// user ke liye". This panel reads from `GET /admin/wd-rules` which
// returns the CALLER'S OWN tier override (sparse — blanks mean "inherit
// from the layer below") plus the resolved effective values + per-field
// source labels. Form state seeds from the own row; saves go through
// `PUT /admin/wd-rules/{type}` which auto-targets the caller's tier.

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

export function WdRulesPanel() {
  const { data: rules } = useQuery({
    queryKey: ["admin", "wd-rules"],
    queryFn: () => PayinOutAPI.wdRules(),
  });

  if (!rules) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading rules…
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
        <p className="font-semibold text-primary">
          {rules.tier === "super_admin"
            ? "Super-admin pool"
            : rules.tier === "admin"
              ? "Your admin pool"
              : "Your broker pool"}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {rules.tier === "super_admin"
            ? "Applies to your direct users. Cascades into admin / broker pools as the fallback when they leave fields blank."
            : rules.tier === "admin"
              ? "Applies to users you own. Field left blank → inherits from super-admin."
              : "Applies to users in your sub-tree. Field left blank → inherits from your admin / super-admin."}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rules.rules.map((r) => (
          <WdRuleCard key={r.rule_type} rule={r} />
        ))}
      </div>
    </section>
  );
}

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
  // Form seeds from the OWN row only. A null here means "this admin
  // didn't override this field" — we surface the inherited value as a
  // placeholder so the operator always sees what users will actually
  // get even when nothing is set at this tier.
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
    const current =
      form.allowed_days ?? rule.effective.allowed_days ?? [0, 1, 2, 3, 4, 5, 6];
    const next = current.includes(i)
      ? current.filter((d: number) => d !== i)
      : [...current, i].sort();
    setForm((f) => ({ ...f, allowed_days: next }));
  }

  async function save() {
    setSaving(true);
    try {
      // Operator 22-May trimmed the UI to just Min / Max / Allowed days /
      // Mandatory remark — daily limit / auto-approve / charges / time
      // window are now ALWAYS sent as `null` so they explicitly clear
      // at this tier. That keeps the cascade clean even if a previous
      // version of this form (or the global seed) had them set.
      const payload: Record<string, any> = {
        min_amount: form.min_amount === "" || form.min_amount === null ? null : String(form.min_amount),
        max_amount: form.max_amount === "" || form.max_amount === null ? null : String(form.max_amount),
        mandatory_remark: form.mandatory_remark,
        allowed_days: form.allowed_days,
        // Always null — operator-removed fields. Sending null clears any
        // historical override at this tier; the validator then skips
        // those checks entirely (it treats 0 daily_limit and empty
        // allowed_times as "no restriction").
        daily_limit: null,
        auto_approve_under: null,
        charges_flat: null,
        charges_percent: null,
        allowed_times: null,
      };

      await PayinOutAPI.updateWdRule(rule.rule_type, payload);
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["admin", "wd-rules"] });
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const effActiveDays: number[] =
    rule.effective.allowed_days ?? [0, 1, 2, 3, 4, 5, 6];
  const formActiveDays: number[] = form.allowed_days ?? effActiveDays;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{rule.rule_type}</CardTitle>
        <CardDescription className="text-xs">
          Blanks inherit from the layer below — leave a field empty if you
          don't want to override it.
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
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Allowed days</Label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => {
              const active = formActiveDays.includes(d.i);
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

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={
              form.mandatory_remark === null
                ? !!rule.effective.mandatory_remark
                : !!form.mandatory_remark
            }
            onChange={(e) =>
              setForm((f) => ({ ...f, mandatory_remark: e.target.checked }))
            }
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
  return days
    .map((d) => WEEKDAYS[d]?.label)
    .filter(Boolean)
    .join(", ");
}

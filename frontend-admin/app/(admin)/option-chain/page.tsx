"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { SettingsAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";

interface UnderlyingCfg {
  label: string;
  symbol: string;
  color: string;
}

const COLOR_CHOICES = ["emerald", "violet", "rose", "amber", "sky", "fuchsia"] as const;
const COLOR_DOT: Record<string, string> = {
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  fuchsia: "bg-fuchsia-500",
};

const KEYS = {
  underlyings: "option_chain.underlyings",
  strikesAroundAtm: "option_chain.strikes_around_atm",
  maxExpiries: "option_chain.max_expiries",
};

export default function OptionChainAdminPage() {
  const qc = useQueryClient();

  const { data: rows } = useQuery({
    queryKey: ["admin", "settings", "platform", "option_chain"],
    queryFn: () => SettingsAPI.platformList("option_chain"),
  });

  // Local edit buffer
  const [underlyings, setUnderlyings] = useState<UnderlyingCfg[]>([]);
  const [strikesAroundAtm, setStrikesAroundAtm] = useState<number>(15);
  const [maxExpiries, setMaxExpiries] = useState<number>(6);
  const [saving, setSaving] = useState(false);

  // Hydrate state once row data arrives
  useEffect(() => {
    if (!rows) return;
    for (const r of rows) {
      if (r.key === KEYS.underlyings && Array.isArray(r.value)) setUnderlyings(r.value);
      if (r.key === KEYS.strikesAroundAtm) setStrikesAroundAtm(Number(r.value) || 15);
      if (r.key === KEYS.maxExpiries) setMaxExpiries(Number(r.value) || 6);
    }
  }, [rows]);

  // Diff vs current server state — used to enable Save
  const dirty = useMemo(() => {
    if (!rows) return false;
    const u = rows.find((r: any) => r.key === KEYS.underlyings)?.value;
    const s = Number(rows.find((r: any) => r.key === KEYS.strikesAroundAtm)?.value);
    const m = Number(rows.find((r: any) => r.key === KEYS.maxExpiries)?.value);
    if (s !== strikesAroundAtm) return true;
    if (m !== maxExpiries) return true;
    return JSON.stringify(u ?? []) !== JSON.stringify(underlyings);
  }, [rows, underlyings, strikesAroundAtm, maxExpiries]);

  function addUnderlying() {
    setUnderlyings((p) => [...p, { label: "", symbol: "", color: "emerald" }]);
  }

  function updateUnderlying(idx: number, patch: Partial<UnderlyingCfg>) {
    setUnderlyings((p) => p.map((u, i) => (i === idx ? { ...u, ...patch } : u)));
  }

  function removeUnderlying(idx: number) {
    setUnderlyings((p) => p.filter((_, i) => i !== idx));
  }

  async function save() {
    // Validate
    for (const u of underlyings) {
      if (!u.label.trim() || !u.symbol.trim()) {
        toast.error("Every underlying needs a label and a symbol");
        return;
      }
    }
    if (strikesAroundAtm < 1 || strikesAroundAtm > 100) {
      toast.error("Strikes around ATM must be between 1 and 100");
      return;
    }
    if (maxExpiries < 1 || maxExpiries > 24) {
      toast.error("Max expiries must be between 1 and 24");
      return;
    }
    setSaving(true);
    try {
      // Normalise: trim + uppercase symbols
      const cleaned = underlyings.map((u) => ({
        label: u.label.trim(),
        symbol: u.symbol.trim().toUpperCase().replace(/\s+/g, ""),
        color: u.color,
      }));
      await Promise.all([
        SettingsAPI.updatePlatform(KEYS.underlyings, cleaned),
        SettingsAPI.updatePlatform(KEYS.strikesAroundAtm, strikesAroundAtm),
        SettingsAPI.updatePlatform(KEYS.maxExpiries, maxExpiries),
      ]);
      toast.success("Option chain settings saved");
      qc.invalidateQueries({ queryKey: ["admin", "settings", "platform", "option_chain"] });
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Option chain configuration"
        description="Controls the option-chain picker users see when they tap '+' on the chart tabs. Live LTPs update tick-by-tick when Zerodha is connected."
        actions={
          <Button onClick={save} disabled={!dirty} loading={saving}>
            Save changes
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Underlyings */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Underlyings</CardTitle>
            <CardDescription>
              Chips shown across the top of the picker. The user chooses one and we resolve its
              option chain (CE | STRIKE | PE) live from Zerodha or seeded data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {underlyings.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                No underlyings configured. Add at least one.
              </div>
            )}
            {underlyings.map((u, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_1fr_140px_auto] items-end gap-2 rounded-md border border-border bg-muted/10 p-2"
              >
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Label</Label>
                  <Input
                    value={u.label}
                    onChange={(e) => updateUnderlying(idx, { label: e.target.value })}
                    placeholder="Nifty"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Symbol</Label>
                  <Input
                    value={u.symbol}
                    onChange={(e) => updateUnderlying(idx, { symbol: e.target.value.toUpperCase() })}
                    placeholder="NIFTY"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Color</Label>
                  <div className="flex h-9 items-center gap-1 rounded-md border border-border bg-background px-2">
                    {COLOR_CHOICES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => updateUnderlying(idx, { color: c })}
                        className={`size-4 rounded-full ring-2 ring-offset-2 ring-offset-background transition-colors ${COLOR_DOT[c]} ${
                          u.color === c ? "ring-foreground/60" : "ring-transparent"
                        }`}
                        aria-label={c}
                      />
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeUnderlying(idx)}
                  aria-label="Remove"
                >
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addUnderlying}>
              <Plus className="size-4" /> Add underlying
            </Button>
          </CardContent>
        </Card>

        {/* Numeric settings */}
        <Card>
          <CardHeader>
            <CardTitle>Display window</CardTitle>
            <CardDescription>
              How many strikes and expiries the picker exposes to users.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Strikes around ATM</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={strikesAroundAtm}
                onChange={(e) => setStrikesAroundAtm(Number(e.target.value || 1))}
              />
              <p className="text-[11px] text-muted-foreground">
                We render <span className="font-tabular">{strikesAroundAtm * 2 + 1}</span> strikes total
                (ATM ± {strikesAroundAtm}).
              </p>
            </div>
            <div className="space-y-1">
              <Label>Max expiries</Label>
              <Input
                type="number"
                min={1}
                max={24}
                value={maxExpiries}
                onChange={(e) => setMaxExpiries(Number(e.target.value || 1))}
              />
              <p className="text-[11px] text-muted-foreground">
                Only the nearest {maxExpiries} expiries are exposed to users; the rest are hidden.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

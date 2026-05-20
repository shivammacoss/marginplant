"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardCopy, EraserIcon, Plus, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { NettingAPI, UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CATEGORY_FIELDS, isFieldNA, type SegmentRow } from "@/lib/nettingMatrixConfig";
import { Cell } from "./Cell";
import { CategoryChips } from "./CategoryChips";

export function UserOverrides() {
  const qc = useQueryClient();
  const sp = useSearchParams();
  const deepLinkUser = sp.get("user");
  const [userQuery, setUserQuery] = useState("");
  const [user, setUser] = useState<any | null>(null);
  // Clear-all-overrides confirm dialog target. Stores the pill the
  // admin clicked the X on so the modal can show their user_code +
  // override_count for confirmation.
  const [clearTarget, setClearTarget] = useState<any | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (deepLinkUser && !user) {
      UsersAPI.detail(deepLinkUser).then(setUser).catch(() => {});
    }
  }, [deepLinkUser]);

  const { data: search } = useQuery({
    queryKey: ["admin", "users", "netting-search", userQuery],
    queryFn: () => UsersAPI.list({ q: userQuery, page_size: 8 }),
    enabled: userQuery.trim().length >= 2,
  });

  // Quick-pick: every user who already has at least one segment override.
  // Refetches after every save / reset / copy so the count stays current.
  const { data: usersWithOverrides } = useQuery({
    queryKey: ["admin", "netting", "users-with-overrides"],
    queryFn: () => NettingAPI.usersWithOverrides(),
    refetchOnWindowFocus: false,
  });

  const { data: segments } = useQuery({
    queryKey: ["admin", "netting", "segments"],
    queryFn: () => NettingAPI.segments(),
  });
  const { data: overrides } = useQuery({
    queryKey: ["admin", "netting", "user", user?.id],
    queryFn: () => NettingAPI.userOverrides(user.id),
    enabled: !!user,
  });

  // ── Copy-from-another-user picker ──────────────────────────────
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyQuery, setCopyQuery] = useState("");
  const [copying, setCopying] = useState(false);
  const { data: copySearch } = useQuery({
    queryKey: ["admin", "users", "netting-copy-search", copyQuery],
    queryFn: () => UsersAPI.list({ q: copyQuery, page_size: 8 }),
    enabled: copyQuery.trim().length >= 2,
  });

  async function copyFrom(source: any) {
    if (!user) return;
    if (source.id === user.id) {
      toast.error("Source and destination users must be different");
      return;
    }
    if (!confirm(`Copy ${source.user_code}'s segment overrides onto ${user.user_code}? Overwrites the existing override docs.`)) return;
    setCopying(true);
    try {
      await NettingAPI.copy({ source_user_id: source.id, target_user_ids: [user.id], overwrite: true });
      toast.success(`Copied segment overrides from ${source.user_code}`);
      setCopyOpen(false);
      setCopyQuery("");
      qc.invalidateQueries({ queryKey: ["admin", "netting", "user", user.id] });
      qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
    } catch (e: any) {
      toast.error(e.message || "Copy failed");
    } finally {
      setCopying(false);
    }
  }

  const [category, setCategory] = useState("lot");
  const fields = CATEGORY_FIELDS[category] || [];
  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [saving, setSaving] = useState(false);

  function getOverride(segName: string, key: string) {
    const row = overrides?.find((r: any) => r.segment_name === segName && !r.symbol);
    return row?.[key];
  }
  function getValue(segName: string, key: string) {
    if (edits[segName]?.[key] !== undefined) return edits[segName][key];
    return getOverride(segName, key) ?? "";
  }
  function setEdit(segName: string, key: string, val: any) {
    setEdits((prev) => ({ ...prev, [segName]: { ...(prev[segName] || {}), [key]: val } }));
  }

  const dirtyCount = Object.values(edits).reduce((s, e) => s + Object.keys(e).length, 0);

  async function saveAll() {
    if (!user) return;
    setSaving(true);
    try {
      for (const segName of Object.keys(edits)) {
        await NettingAPI.upsertUserOverride(user.id, segName, edits[segName]);
      }
      toast.success(`Saved ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`);
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin", "netting", "user", user.id] });
      qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function reset(segName: string) {
    if (!user) return;
    if (!confirm(`Remove ${user.user_code}'s override for ${segName}?`)) return;
    try {
      await NettingAPI.deleteUserOverride(user.id, segName);
      toast.success("Reset");
      qc.invalidateQueries({ queryKey: ["admin", "netting", "user", user.id] });
      qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-3">
      {/* Quick-pick: users who already have at least one segment override */}
      {(usersWithOverrides?.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <Label className="mb-1.5 block text-[11px] text-amber-700 dark:text-amber-300">
            Users with custom segment override ({usersWithOverrides?.length})
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {usersWithOverrides?.map((u: any) => {
              const active = user?.id === u.id;
              return (
                <span
                  key={u.id}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-[11px] transition-colors " +
                    (active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-amber-500/40 bg-background text-foreground hover:bg-amber-500/10")
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      setUser(u);
                      setUserQuery("");
                    }}
                    className="flex items-center gap-1 rounded-full px-1.5 py-0 outline-none"
                    title={`${u.full_name} — ${u.override_count} segment override doc${u.override_count === 1 ? "" : "s"}`}
                  >
                    <span className="font-mono">{u.user_code}</span>
                    <span className={active ? "text-primary-foreground/80" : "text-muted-foreground"}>
                      ({u.override_count})
                    </span>
                  </button>
                  {/* Clear-all button: removes every per-user override
                      so the user falls back onto the inherited
                      cascade. Admin-flagged: "user me ek baar setting
                      karne ke baad delete karne ka option nahi hai
                      taki user wapas global me a jaye". */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setClearTarget(u);
                    }}
                    title={`Reset ${u.user_code} to inherited settings`}
                    className={
                      "grid size-4 place-items-center rounded-full transition-colors " +
                      (active
                        ? "hover:bg-primary-foreground/20 text-primary-foreground/70"
                        : "hover:bg-amber-500/20 text-muted-foreground hover:text-amber-700")
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Confirm dialog for the clear-all action. Renders the user's
          code + override count so the admin doesn't fat-finger the
          wrong row. */}
      <Dialog open={!!clearTarget} onOpenChange={(o) => { if (!o) setClearTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset overrides?</DialogTitle>
          </DialogHeader>
          {clearTarget && (
            <p className="text-xs text-muted-foreground">
              Remove all {clearTarget.override_count} segment / script
              override{clearTarget.override_count === 1 ? "" : "s"} for{" "}
              <span className="font-mono text-foreground">{clearTarget.user_code}</span>
              {clearTarget.full_name ? (
                <> ({clearTarget.full_name})</>
              ) : null}
              ? The user will fall back to your tier&apos;s default
              settings (and below: super-admin / platform defaults).
              Their open positions are NOT affected; only future order
              validation reads from the cleaned cascade.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClearTarget(null)}
              disabled={clearing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={clearing}
              disabled={clearing}
              onClick={async () => {
                if (!clearTarget) return;
                setClearing(true);
                try {
                  const r = await NettingAPI.clearAllUserOverrides(clearTarget.id);
                  toast.success(
                    `Reset ${clearTarget.user_code} — removed ${r?.deleted ?? 0} override(s)`,
                  );
                  setClearTarget(null);
                  // If the clear target is the currently-selected
                  // user the table refetch needs to clear ALL the
                  // staged drafts too; reset the local edit map.
                  if (user?.id === clearTarget.id) {
                    setEdits({});
                  }
                  qc.invalidateQueries({ queryKey: ["admin", "netting", "user", clearTarget.id] });
                  qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
                } catch (e: any) {
                  toast.error(e?.message ?? "Reset failed");
                } finally {
                  setClearing(false);
                }
              }}
            >
              <EraserIcon className="size-4" /> Reset overrides
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-md border border-border bg-muted/10 p-3">
        <Label>Search user</Label>
        <div className="relative mt-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={userQuery}
            onChange={(e) => {
              setUserQuery(e.target.value);
              setUser(null);
            }}
            placeholder="code / email / name (min 2 chars)"
            className="pl-9"
          />
        </div>
        {userQuery.trim().length >= 2 && !user && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-background scrollbar-thin">
            {(search?.items ?? []).length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">No matches.</div>
            ) : (
              search?.items.map((u: any) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setUser(u)}
                  className="flex w-full items-center justify-between border-b border-border/40 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted/30"
                >
                  <span>
                    <span className="font-mono">{u.user_code}</span>
                    <span className="ml-2 text-muted-foreground">{u.full_name}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        {user && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
            <div>
              <div className="font-medium">{user.user_code}</div>
              <div className="text-muted-foreground">{user.full_name}</div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-[11px]"
                onClick={() => setCopyOpen((o) => !o)}
                title="Copy another user's segment overrides onto this user"
              >
                <ClipboardCopy className="size-3" /> Copy from…
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setUser(null);
                  setUserQuery("");
                  setCopyOpen(false);
                }}
              >
                <X className="size-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Copy-from picker */}
        {user && copyOpen && (
          <div className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
            <Label className="text-[11px] text-amber-700 dark:text-amber-300">
              Copy segment overrides from another user
            </Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={copyQuery}
                onChange={(e) => setCopyQuery(e.target.value)}
                placeholder="code / email / name (min 2 chars)"
                className="h-8 pl-9 text-xs"
              />
            </div>
            {copyQuery.trim().length >= 2 && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background scrollbar-thin">
                {(copySearch?.items ?? []).filter((u: any) => u.id !== user.id).length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">No matches.</div>
                ) : (
                  copySearch?.items
                    .filter((u: any) => u.id !== user.id)
                    .map((u: any) => (
                      <button
                        key={u.id}
                        type="button"
                        disabled={copying}
                        onClick={() => copyFrom(u)}
                        className="flex w-full items-center justify-between border-b border-border/40 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-amber-500/10 disabled:opacity-50"
                      >
                        <span>
                          <span className="font-mono">{u.user_code}</span>
                          <span className="ml-2 text-muted-foreground">{u.full_name}</span>
                        </span>
                        <span className="text-[10px] text-amber-600">copy →</span>
                      </button>
                    ))
                )}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Copies every per-segment override (lot, qty, margin, brokerage, …) from the source user onto {user.user_code}.
            </p>
          </div>
        )}
      </div>

      {user && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryChips value={category} onChange={setCategory} />
            <Button
              className="ml-auto"
              onClick={saveAll}
              disabled={dirtyCount === 0}
              loading={saving}
            >
              <Save className="size-4" /> Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
            </Button>
          </div>

          {/* Section header for the segment-wide table below. The
              script-level (per-symbol) table follows in its own
              section so the admin can edit both shapes on the same
              page without switching tabs — user spec: "2 sections,
              segment + script, dono single user ke liye, save kar
              sake". */}
          <div className="flex items-center gap-2 px-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Segment-wide overrides</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-foreground/70">
              applies to every symbol in the segment
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="min-w-full text-xs">
              <thead className="bg-card">
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-muted-foreground">
                    Segment
                  </th>
                  {fields.map((f) => (
                    <th
                      key={f.key}
                      className="whitespace-nowrap px-2 py-2 text-left text-muted-foreground"
                    >
                      {f.label}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right text-muted-foreground">Reset</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(segments ?? []).map((seg: any) => {
                  const segRow: SegmentRow = {
                    code: seg.name,
                    name: seg.displayName,
                    lotApplies: seg.lotApplies,
                    qtyApplies: seg.qtyApplies,
                    optionApplies: seg.optionApplies,
                    expiryHoldApplies: seg.expiryHoldApplies,
                    futureApplies: seg.futureApplies,
                  };
                  return (
                    <tr key={seg.id} className="hover:bg-muted/30">
                      <td className="sticky left-0 z-0 whitespace-nowrap bg-card px-3 py-2">
                        <div className="font-medium">{seg.displayName}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">{seg.name}</div>
                      </td>
                      {fields.map((f) => (
                        <td key={f.key} className="px-1 py-1">
                          <Cell
                            field={f}
                            na={isFieldNA(segRow, category, f)}
                            value={getValue(seg.name, f.key)}
                            dirty={edits[seg.name]?.[f.key] !== undefined}
                            inheritPlaceholder
                            onChange={(v) => setEdit(seg.name, f.key, v)}
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right">
                        <Button variant="ghost" size="icon" onClick={() => reset(seg.name)}>
                          <RotateCcw className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Script (per-symbol) overrides ─────────────────────────
              Same category chip controls which fields are editable.
              Each row narrows to a specific symbol within a segment
              (e.g. SBIN in NSE_EQ) and saves via the SAME upsert
              endpoint with a `symbol` query param. Mirrors the
              segment-wide table above but the row carries an extra
              "Symbol" column. */}
          <UserScriptOverrides
            user={user}
            segments={segments ?? []}
            category={category}
            fields={fields}
            overrides={overrides ?? []}
          />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Per-symbol section
// ─────────────────────────────────────────────────────────────────
function UserScriptOverrides({
  user,
  segments,
  category,
  fields,
  overrides,
}: {
  user: any;
  segments: any[];
  category: string;
  fields: { key: string; label: string; type: string; options?: { v: any; l: string }[] }[];
  overrides: any[];
}) {
  const qc = useQueryClient();

  // Rows already saved server-side (symbol non-null).
  const symbolRows = useMemo(
    () => (overrides ?? []).filter((r: any) => !!r.symbol),
    [overrides],
  );

  // Add-symbol form state.
  const [addOpen, setAddOpen] = useState(false);
  const [addSegment, setAddSegment] = useState<string>(segments[0]?.name ?? "");
  const [addSymbol, setAddSymbol] = useState("");

  // Per-(segment, symbol) edit drafts — same shape as the segment
  // table's `edits`, but the OUTER key includes the symbol so two
  // rows for the same segment but different symbols don't collide.
  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [saving, setSaving] = useState(false);

  function rowKey(seg: string, sym: string) {
    return `${seg}::${sym.toUpperCase()}`;
  }
  function getOverride(seg: string, sym: string, field: string) {
    const row = symbolRows.find(
      (r: any) => r.segment_name === seg && (r.symbol ?? "") === sym,
    );
    return row?.[field];
  }
  function getValue(seg: string, sym: string, field: string) {
    const key = rowKey(seg, sym);
    if (edits[key]?.[field] !== undefined) return edits[key][field];
    return getOverride(seg, sym, field) ?? "";
  }
  function setEdit(seg: string, sym: string, field: string, val: any) {
    const key = rowKey(seg, sym);
    setEdits((prev) => ({
      ...prev,
      [key]: { ...(prev[key] || {}), [field]: val },
    }));
  }

  const dirtyCount = Object.values(edits).reduce(
    (s, e) => s + Object.keys(e).length,
    0,
  );

  async function saveAll() {
    if (!user) return;
    setSaving(true);
    try {
      for (const key of Object.keys(edits)) {
        const [seg, sym] = key.split("::");
        if (!seg || !sym) continue;
        await NettingAPI.upsertUserOverride(user.id, seg, edits[key], sym);
      }
      toast.success(`Saved ${dirtyCount} script override change${dirtyCount === 1 ? "" : "s"}`);
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin", "netting", "user", user.id] });
      qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(seg: string, sym: string) {
    if (!user) return;
    if (!confirm(`Remove ${user.user_code}'s override for ${sym} in ${seg}?`)) return;
    try {
      await NettingAPI.deleteUserOverride(user.id, seg, sym);
      toast.success("Script override removed");
      qc.invalidateQueries({ queryKey: ["admin", "netting", "user", user.id] });
      qc.invalidateQueries({ queryKey: ["admin", "netting", "users-with-overrides"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Remove failed");
    }
  }

  function addRow() {
    const sym = addSymbol.trim().toUpperCase();
    if (!addSegment) {
      toast.error("Pick a segment");
      return;
    }
    if (!sym) {
      toast.error("Enter a symbol");
      return;
    }
    const exists =
      symbolRows.some(
        (r: any) => r.segment_name === addSegment && (r.symbol ?? "") === sym,
      ) || edits[rowKey(addSegment, sym)] !== undefined;
    if (exists) {
      toast.info("That (segment, symbol) is already in the list — scroll up to edit it");
      return;
    }
    // Seed an empty draft so the row appears with inheritable
    // placeholders; admin then fills cells normally.
    setEdits((prev) => ({ ...prev, [rowKey(addSegment, sym)]: {} }));
    setAddSymbol("");
    setAddOpen(false);
  }

  // Union of saved rows + currently-drafted-but-unsaved rows.
  const allKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of symbolRows) {
      set.add(rowKey(r.segment_name, r.symbol));
    }
    for (const k of Object.keys(edits)) set.add(k);
    return [...set].sort();
  }, [symbolRows, edits]);

  return (
    <div className="space-y-2 pt-3">
      <div className="flex flex-wrap items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Script (per-symbol) overrides</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-foreground/70">
          applies only to the picked symbol — most-specific layer in the resolver cascade
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirtyCount > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold normal-case tracking-normal text-amber-600 dark:text-amber-400">
              {dirtyCount} unsaved
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddOpen((v) => !v)}
            className="h-7 gap-1 text-[11px] normal-case"
          >
            <Plus className="size-3" /> Add symbol
          </Button>
          <Button
            size="sm"
            onClick={saveAll}
            disabled={dirtyCount === 0}
            loading={saving}
            className="h-7 gap-1 text-[11px] normal-case"
          >
            <Save className="size-3" /> Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
          </Button>
        </div>
      </div>

      {addOpen && (
        <div className="grid grid-cols-1 gap-2 rounded-md border border-dashed border-border bg-muted/10 p-3 sm:grid-cols-[1fr_1fr_auto]">
          <div>
            <Label className="text-[11px]">Segment</Label>
            <select
              value={addSegment}
              onChange={(e) => setAddSegment(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              {segments.map((s: any) => (
                <option key={s.name} value={s.name}>
                  {s.displayName} ({s.name})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[11px]">Symbol</Label>
            <Input
              value={addSymbol}
              onChange={(e) => setAddSymbol(e.target.value)}
              placeholder="e.g. SBIN, NIFTYFUT, BTCUSD"
              className="mt-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRow();
                }
              }}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={addRow} className="h-9">
              Add row
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="min-w-full text-xs">
          <thead className="bg-card">
            <tr className="border-b border-border">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-muted-foreground">
                Segment / Symbol
              </th>
              {fields.map((f) => (
                <th
                  key={f.key}
                  className="whitespace-nowrap px-2 py-2 text-left text-muted-foreground"
                >
                  {f.label}
                </th>
              ))}
              <th className="px-2 py-2 text-right text-muted-foreground">Remove</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {allKeys.length === 0 && (
              <tr>
                <td
                  colSpan={fields.length + 2}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No per-symbol overrides yet. Click <b>Add symbol</b> to create one for{" "}
                  {user?.user_code ?? "this user"}.
                </td>
              </tr>
            )}
            {allKeys.map((key) => {
              const [seg, sym] = key.split("::");
              const segMeta = segments.find((s: any) => s.name === seg);
              if (!segMeta) return null;
              const segRow: SegmentRow = {
                code: segMeta.name,
                name: segMeta.displayName,
                lotApplies: segMeta.lotApplies,
                qtyApplies: segMeta.qtyApplies,
                optionApplies: segMeta.optionApplies,
                expiryHoldApplies: segMeta.expiryHoldApplies,
                futureApplies: segMeta.futureApplies,
              };
              return (
                <tr key={key} className="hover:bg-muted/30">
                  <td className="sticky left-0 z-0 whitespace-nowrap bg-card px-3 py-2">
                    <div className="font-medium">{sym}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {segMeta.name}
                    </div>
                  </td>
                  {fields.map((f) => (
                    <td key={f.key} className="px-1 py-1">
                      <Cell
                        field={f as any}
                        na={isFieldNA(segRow, category, f as any)}
                        value={getValue(seg, sym, f.key)}
                        dirty={edits[key]?.[f.key] !== undefined}
                        inheritPlaceholder
                        onChange={(v) => setEdit(seg, sym, f.key, v)}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteRow(seg, sym)}
                      title="Remove this per-symbol override"
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

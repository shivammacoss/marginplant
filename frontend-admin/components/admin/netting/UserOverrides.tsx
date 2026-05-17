"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardCopy, RotateCcw, Save, Search, X } from "lucide-react";
import { NettingAPI, UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
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
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setUser(u);
                    setUserQuery("");
                  }}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
                    (active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-amber-500/40 bg-background text-foreground hover:bg-amber-500/10")
                  }
                  title={`${u.full_name} — ${u.override_count} segment override doc${u.override_count === 1 ? "" : "s"}`}
                >
                  <span className="font-mono">{u.user_code}</span>
                  <span className={active ? "text-primary-foreground/80" : "text-muted-foreground"}>
                    ({u.override_count})
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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
        </>
      )}
    </div>
  );
}

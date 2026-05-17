"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { NettingAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CATEGORY_FIELDS, isFieldNA, type SegmentRow } from "@/lib/nettingMatrixConfig";
import { Cell } from "./Cell";
import { useAdminAuthStore } from "@/stores/authStore";
import { canEdit } from "@/lib/permissions";

export function SegmentMatrix({ categoryId }: { categoryId: string }) {
  const qc = useQueryClient();
  const me = useAdminAuthStore((s) => s.admin);
  const canMutate = canEdit(me, "segment_settings");
  const fields = CATEGORY_FIELDS[categoryId] || [];
  const { data: segments, isLoading } = useQuery({
    queryKey: ["admin", "netting", "segments"],
    queryFn: () => NettingAPI.segments(),
  });

  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [saving, setSaving] = useState(false);

  function setEdit(segId: string, key: string, val: any) {
    setEdits((prev) => ({ ...prev, [segId]: { ...(prev[segId] || {}), [key]: val } }));
  }
  function getValue(seg: any, key: string) {
    if (edits[seg.id]?.[key] !== undefined) return edits[seg.id][key];
    return seg[key];
  }

  // Self-heal stored select values that are no longer a valid option
  // (legacy enum like `marginCalcMode: "percent"` after we retired that
  // mode). Stage a dirty edit so the next Save normalises the row to a
  // current option.
  //
  // Critically: do NOT stage for null/undefined values. The backend
  // resolver has a defensive inference path (sniff intradayMargin > 100
  // → Times, else Fixed) that handles unset rows correctly. If we
  // pre-stage "fixed" here, an admin who edits `intradayMargin` from
  // default 100 → 700 expecting Times leverage will silently get
  // "Fixed · ₹100/lot" because Save commits both the staged
  // "marginCalcMode=fixed" AND keeps intradayMargin at 100 (the change
  // they thought they made never got typed in). Leave null alone — the
  // admin's explicit dropdown click is the only way to commit a mode.
  useEffect(() => {
    if (!segments || !fields.length) return;
    setEdits((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const seg of segments as any[]) {
        for (const f of fields) {
          if (f.type !== "select") continue;
          const stored = seg[f.key];
          // Leave unset values alone — backend resolver infers.
          if (stored === null || stored === undefined || stored === "") continue;
          const valid = (f.options ?? []).some((o: any) => String(o.v) === String(stored));
          if (valid) continue;
          const fallback = f.options?.[0]?.v;
          if (fallback === undefined) continue;
          if (next[seg.id]?.[f.key] === fallback) continue;
          next[seg.id] = { ...(next[seg.id] || {}), [f.key]: fallback };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // intentional: rerun whenever the data refetches or the category changes
  }, [segments, fields]);

  const dirtyCount = Object.values(edits).reduce((s, e) => s + Object.keys(e).length, 0);

  async function saveAll() {
    setSaving(true);
    try {
      // Parallelise the PUTs. The old sequential loop made saving 14 dirty
      // segments take ~14× longer than necessary because every backend
      // request also does an O(N) Redis SCAN to invalidate the per-user
      // effective-settings cache. With Promise.all the round-trips overlap
      // and total wall time drops to ~one slow request, not the sum of all.
      const ids = Object.keys(edits);
      await Promise.all(ids.map((id) => NettingAPI.updateSegment(id, edits[id])));
      toast.success(`Saved ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`);
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin", "netting", "segments"] });
      // Also evict the user-side effective-settings cache key so any tab the
      // admin has open (terminal preview, etc.) refetches the new numbers on
      // its next 30 s window instead of holding stale values.
      qc.invalidateQueries({ queryKey: ["segment-settings"] });
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading segments…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button
          onClick={saveAll}
          disabled={dirtyCount === 0 || !canMutate}
          title={canMutate ? undefined : "View-only access"}
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
                <th key={f.key} className="whitespace-nowrap px-2 py-2 text-left text-muted-foreground">
                  {f.label}
                </th>
              ))}
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
                        na={isFieldNA(segRow, categoryId, f)}
                        value={getValue(seg, f.key)}
                        dirty={edits[seg.id]?.[f.key] !== undefined}
                        onChange={(v) => setEdit(seg.id, f.key, v)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

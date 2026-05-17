"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Save, Trash2 } from "lucide-react";
import { InstrumentAdminAPI, NettingAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CATEGORY_FIELDS, isFieldNA } from "@/lib/nettingMatrixConfig";
import { Cell } from "./Cell";


export function ScriptOverrides({ categoryId }: { categoryId: string }) {
  const qc = useQueryClient();
  const fields = CATEGORY_FIELDS[categoryId] || [];
  const { data: segments } = useQuery({
    queryKey: ["admin", "netting", "segments"],
    queryFn: () => NettingAPI.segments(),
  });
  const [segmentName, setSegmentName] = useState<string>("");
  const { data: scripts, isLoading } = useQuery({
    queryKey: ["admin", "netting", "scripts", segmentName],
    queryFn: () => NettingAPI.scripts(segmentName || undefined),
    enabled: !!segments,
  });

  const [edits, setEdits] = useState<Record<string, Record<string, any>>>({});
  const [saving, setSaving] = useState(false);
  const [newSym, setNewSym] = useState("");
  const [newSymDebounced, setNewSymDebounced] = useState("");
  const [newSegId, setNewSegId] = useState("");
  const [adding, setAdding] = useState(false);

  // Debounce the symbol input so the typeahead doesn't hammer the admin
  // instruments endpoint on every keystroke. 200 ms matches the user-side
  // panel's debounce — same "feels instant" feel without thrashing Mongo.
  useEffect(() => {
    const t = setTimeout(() => setNewSymDebounced(newSym), 200);
    return () => clearTimeout(t);
  }, [newSym]);

  // Decode the picked segment into the bits the picker needs:
  //   • exchange  — Kite business channel (NSE / NFO / BSE / BFO / MCX)
  //   • mode      — "eq" (cash stocks, exact match) | "fut" (futures
  //                 pattern) | "opt" (option pattern, expanded to two
  //                 rows per underlying for CE + PE)
  const newSeg = segments?.find((s: any) => s.id === newSegId);
  const segName = (newSeg?.name || "").toUpperCase();
  const { exchange: exchangeForSeg, mode: pickerMode } = (() => {
    if (segName === "NSE_EQ") return { exchange: "NSE", mode: "eq" as const };
    if (segName === "NSE_FUT") return { exchange: "NFO", mode: "fut" as const };
    if (segName === "NSE_OPT") return { exchange: "NFO", mode: "opt" as const };
    if (segName === "BSE_EQ") return { exchange: "BSE", mode: "eq" as const };
    if (segName === "BSE_FUT") return { exchange: "BFO", mode: "fut" as const };
    if (segName === "BSE_OPT") return { exchange: "BFO", mode: "opt" as const };
    if (segName === "MCX_FUT") return { exchange: "MCX", mode: "fut" as const };
    if (segName === "MCX_OPT") return { exchange: "MCX", mode: "opt" as const };
    if (segName === "CRYPTO") return { exchange: "CRYPTO", mode: "eq" as const };
    return { exchange: undefined, mode: undefined };
  })();

  // EQ segments: search real instrument symbols (exact match scripts).
  const { data: eqHits } = useQuery({
    queryKey: ["admin", "script-eq-hits", exchangeForSeg, newSymDebounced],
    queryFn: () =>
      InstrumentAdminAPI.list({
        q: newSymDebounced.trim(),
        exchange: exchangeForSeg,
        page_size: 12,
      }),
    enabled: pickerMode === "eq" && !!exchangeForSeg && newSymDebounced.trim().length >= 1,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // F&O segments: search deduped underlyings (one row per NIFTY /
  // BANKNIFTY / SBIN / …). For OPT segments we fetch CE underlyings
  // because the universe is the same as PE — the picker just renders
  // each underlying twice (once as "<UND> (CE)", once as "<UND> (PE)").
  const futExchanges = pickerMode === "fut" || pickerMode === "opt" ? exchangeForSeg : undefined;
  const { data: undHits } = useQuery({
    queryKey: ["admin", "script-und-hits", futExchanges, pickerMode, newSymDebounced],
    queryFn: () =>
      InstrumentAdminAPI.underlyings({
        exchange: futExchanges!,
        contract_type: pickerMode === "fut" ? "FUT" : "CE",
        q: newSymDebounced.trim(),
        limit: 12,
      }),
    enabled: !!futExchanges && newSymDebounced.trim().length >= 1,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const [typeaheadOpen, setTypeaheadOpen] = useState(false);

  function setEdit(id: string, key: string, val: any) {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: val } }));
  }
  function getValue(s: any, key: string) {
    if (edits[s.id]?.[key] !== undefined) return edits[s.id][key];
    return s[key];
  }

  const dirtyCount = Object.values(edits).reduce((s, e) => s + Object.keys(e).length, 0);

  async function saveAll() {
    setSaving(true);
    try {
      for (const id of Object.keys(edits)) {
        await NettingAPI.updateScript(id, edits[id]);
      }
      toast.success(`Saved ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`);
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin", "netting", "scripts"] });
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function addScript() {
    if (!newSym.trim()) return toast.error("Enter symbol");
    if (!newSegId) return toast.error("Pick a segment");
    const seg = segments?.find((s: any) => s.id === newSegId);
    if (!seg) return toast.error("Invalid segment");
    setAdding(true);
    try {
      await NettingAPI.createScript({
        segment_id: newSegId,
        segment_name: seg.name,
        symbol: newSym.trim().toUpperCase(),
        tradingSymbol: newSym.trim().toUpperCase(),
      });
      toast.success(`Added ${newSym.trim().toUpperCase()} to ${seg.name}`);
      setNewSym("");
      setNewSegId("");
      qc.invalidateQueries({ queryKey: ["admin", "netting", "scripts"] });
    } catch (e: any) {
      toast.error(e.message || "Add failed");
    } finally {
      setAdding(false);
    }
  }

  async function delScript(id: string, sym: string) {
    if (!confirm(`Remove override for ${sym}?`)) return;
    try {
      await NettingAPI.deleteScript(id);
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["admin", "netting", "scripts"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-muted/10 p-3 text-sm">
        <div className="space-y-1">
          <Label>Segment</Label>
          <select
            value={segmentName}
            onChange={(e) => setSegmentName(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">— All segments —</option>
            {segments?.map((s: any) => (
              <option key={s.id} value={s.name}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <div className="space-y-1">
            <Label>Add symbol to</Label>
            <select
              value={newSegId}
              onChange={(e) => setNewSegId(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">— Pick segment —</option>
              {segments?.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="relative space-y-1">
            <Label>Symbol</Label>
            <Input
              value={newSym}
              onChange={(e) => {
                setNewSym(e.target.value);
                setTypeaheadOpen(true);
              }}
              onFocus={() => setTypeaheadOpen(true)}
              onBlur={() => {
                // Delay close so click on a suggestion lands first.
                setTimeout(() => setTypeaheadOpen(false), 150);
              }}
              placeholder="SBIN  or  NIFTYFUT (all NIFTY futs)"
              className="h-9 w-64 uppercase"
            />
            {/* Typeahead popover — content depends on the segment kind:
                • EQ segments  →  real stock symbols (SBIN, RELIANCE, …)
                • FUT segments →  deduped underlyings (NIFTY, BANKNIFTY, …)
                                  each pick fills `<UND>FUT`.
                • OPT segments →  each underlying rendered twice as
                                  "<UND> (CE)" and "<UND> (PE)" so admin
                                  picks the side; result fills `<UND>CE`
                                  or `<UND>PE`. */}
            {typeaheadOpen && pickerMode && newSymDebounced.trim().length >= 1 && (
              <div className="absolute top-full z-30 mt-1 w-80 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                <div className="max-h-64 divide-y divide-border overflow-y-auto scrollbar-thin">
                  {pickerMode === "eq" ? (
                    (eqHits?.items ?? []).length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground">
                        No matching instruments.
                      </div>
                    ) : (
                      (eqHits!.items as any[]).map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setNewSym(r.symbol);
                            setTypeaheadOpen(false);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/50"
                        >
                          <span className="font-mono">{r.symbol}</span>
                          <span className="truncate text-[10px] text-muted-foreground">
                            {r.exchange} · {r.segment ?? r.instrument_type ?? ""}
                          </span>
                        </button>
                      ))
                    )
                  ) : pickerMode === "fut" ? (
                    (undHits ?? []).length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground">
                        No matching underlyings.
                      </div>
                    ) : (
                      (undHits as string[]).map((u) => (
                        <button
                          key={u}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            // FUT pattern — applies to every expiry.
                            setNewSym(`${u}FUT`);
                            setTypeaheadOpen(false);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/50"
                        >
                          <span className="font-mono font-semibold">{u}</span>
                          <span className="text-[10px] text-muted-foreground">
                            saves as <span className="font-mono">{u}FUT</span> — every expiry
                          </span>
                        </button>
                      ))
                    )
                  ) : (
                    // OPT: render each underlying twice — once for CE, once for PE.
                    (undHits ?? []).length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground">
                        No matching underlyings.
                      </div>
                    ) : (
                      (undHits as string[]).flatMap((u) => (
                        (["CE", "PE"] as const).map((side) => (
                          <button
                            key={`${u}-${side}`}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setNewSym(`${u}${side}`);
                              setTypeaheadOpen(false);
                            }}
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/50"
                          >
                            <span className="font-mono font-semibold">
                              {u} <span className="text-muted-foreground">({side})</span>
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              saves as <span className="font-mono">{u}{side}</span> — every strike + expiry
                            </span>
                          </button>
                        ))
                      ))
                    )
                  )}
                </div>
              </div>
            )}
          </div>
          <Button onClick={addScript} loading={adding}>
            <Plus className="size-4" /> Add
          </Button>
          <Button onClick={saveAll} disabled={dirtyCount === 0} loading={saving}>
            <Save className="size-4" /> Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading scripts…</div>
      ) : (scripts ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No script overrides yet. Pick a segment + add a symbol above to start.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="min-w-full text-xs">
            <thead className="bg-card">
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-muted-foreground">
                  Script
                </th>
                {fields.map((f) => (
                  <th
                    key={f.key}
                    className="whitespace-nowrap px-2 py-2 text-left text-muted-foreground"
                  >
                    {f.label}
                  </th>
                ))}
                <th className="px-2 py-2 text-right text-muted-foreground">Del</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(scripts ?? []).map((s: any) => {
                const segRow = segments?.find((g: any) => g.name === s.segment_name);
                return (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="sticky left-0 z-0 whitespace-nowrap bg-card px-3 py-2">
                      <div className="font-mono text-[11px]">{s.symbol}</div>
                      <div className="text-[10px] text-muted-foreground">{s.segment_name}</div>
                    </td>
                    {fields.map((f) => (
                      <td key={f.key} className="px-1 py-1">
                        <Cell
                          field={f}
                          na={isFieldNA(segRow as any, categoryId, f)}
                          value={getValue(s, f.key)}
                          dirty={edits[s.id]?.[f.key] !== undefined}
                          inheritPlaceholder
                          onChange={(v) => setEdit(s.id, f.key, v)}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1 text-right">
                      <Button variant="ghost" size="icon" onClick={() => delScript(s.id, s.symbol)}>
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

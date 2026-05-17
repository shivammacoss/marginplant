"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/common/PageHeader";
import { CategoryChips } from "@/components/admin/netting/CategoryChips";
import { SegmentMatrix } from "@/components/admin/netting/SegmentMatrix";
import { ScriptOverrides } from "@/components/admin/netting/ScriptOverrides";
import { UserOverrides } from "@/components/admin/netting/UserOverrides";
import { cn } from "@/lib/utils";

type Tab = "segments" | "scripts" | "users";

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "segments", label: "Segments", description: "Per-segment defaults — each row applies only to its own segment's instruments." },
  { id: "scripts", label: "Scripts", description: "Per-symbol overrides within a segment. Empty = inherits the segment default." },
  { id: "users", label: "Users", description: "Pick a user and override segment values just for them." },
];

export default function SegmentSettingsPage() {
  const sp = useSearchParams();
  const initialTab = (sp.get("tab") as Tab) || "segments";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [category, setCategory] = useState("lot");

  const meta = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="space-y-4">
      <PageHeader title="Segment Settings" description={meta.description} />

      {/* Top tabs — Segments | Scripts | Users */}
      <div className="sticky top-0 z-20 -mx-4 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60 scrollbar-thin">
        <div className="inline-flex min-w-full gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab !== "users" && <CategoryChips value={category} onChange={setCategory} />}

      {tab === "segments" && <SegmentMatrix categoryId={category} />}
      {tab === "scripts" && <ScriptOverrides categoryId={category} />}
      {tab === "users" && <UserOverrides />}
    </div>
  );
}

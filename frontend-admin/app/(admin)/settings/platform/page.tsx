"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useState } from "react";
import { SettingsAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";

export default function PlatformSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "settings", "platform"], queryFn: () => SettingsAPI.platformList() });

  const [edits, setEdits] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  function setEdit(k: string, v: any) {
    setEdits((p) => ({ ...p, [k]: v }));
  }

  async function saveAll() {
    setSaving(true);
    try {
      for (const k of Object.keys(edits)) {
        await SettingsAPI.updatePlatform(k, edits[k]);
      }
      toast.success("Saved");
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin", "settings", "platform"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Group by category
  const grouped: Record<string, any[]> = {};
  for (const s of data ?? []) {
    grouped[s.category] = grouped[s.category] || [];
    grouped[s.category].push(s);
  }

  const dirty = Object.keys(edits).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Platform settings"
        description="Tunable platform-wide knobs. Changes apply immediately."
        actions={
          <Button onClick={saveAll} disabled={dirty === 0} loading={saving}>
            Save {dirty > 0 ? `(${dirty})` : ""}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Object.entries(grouped).map(([cat, rows]) => (
          <Card key={cat}>
            <CardHeader>
              <CardTitle className="capitalize">{cat}</CardTitle>
              <CardDescription>{rows.length} setting(s)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {rows.map((s) => (
                <div key={s.key} className="space-y-1">
                  <Label className="font-mono text-[11px] text-muted-foreground">{s.key}</Label>
                  {s.type === "BOOL" ? (
                    <select
                      value={(edits[s.key] ?? s.value) ? "true" : "false"}
                      onChange={(e) => setEdit(s.key, e.target.value === "true")}
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <Input
                      value={String(edits[s.key] ?? s.value ?? "")}
                      onChange={(e) =>
                        setEdit(s.key, s.type === "INTEGER" ? Number(e.target.value) : s.type === "FLOAT" ? Number(e.target.value) : e.target.value)
                      }
                    />
                  )}
                  {s.description && <p className="text-[11px] text-muted-foreground">{s.description}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

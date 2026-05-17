"use client";

import { cn } from "@/lib/utils";
import type { FieldDef } from "@/lib/nettingMatrixConfig";

export function Cell({
  field,
  value,
  dirty,
  na,
  onChange,
  inheritPlaceholder,
}: {
  field: FieldDef;
  value: any;
  dirty: boolean;
  na: boolean;
  onChange: (v: any) => void;
  inheritPlaceholder?: boolean;
}) {
  if (na) {
    return <div className="px-2 py-1 text-center text-[10px] text-muted-foreground/50">—</div>;
  }
  const cls = cn(
    "h-7 w-full min-w-[100px] rounded border px-1 text-[11px]",
    dirty ? "border-amber-500/60 bg-amber-500/10" : "border-border bg-background/50"
  );
  if (field.type === "select") {
    return (
      <select
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = field.options?.find((o) => String(o.v) === raw);
          onChange(opt ? opt.v : raw === "" ? null : raw);
        }}
        className={cls}
      >
        {inheritPlaceholder && <option value="">— inherit —</option>}
        {field.options?.map((o) => (
          <option key={String(o.v)} value={String(o.v)}>
            {o.l}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === "time" ? "time" : "number"}
      step={field.type === "number" ? "0.01" : undefined}
      value={value === undefined || value === null ? "" : value}
      onChange={(e) =>
        onChange(
          e.target.value === ""
            ? null
            : field.type === "number"
            ? Number(e.target.value)
            : e.target.value
        )
      }
      placeholder={inheritPlaceholder ? "inherit" : ""}
      className={cls}
    />
  );
}

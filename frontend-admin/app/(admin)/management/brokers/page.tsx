"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Plus,
  ShieldOff,
  ShieldCheck,
  Pencil,
  LogIn,
  MoreVertical,
  Eye,
} from "lucide-react";

import { BrokerMgmtAPI, setTokens } from "@/lib/api";
import { useAdminAuthStore } from "@/stores/authStore";
import { canSee } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { STORAGE_KEYS } from "@/lib/constants";
import type {
  AdminUser,
  BrokerPermissions,
  PermissionLevel,
} from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PERMISSION_LABELS: Array<{ key: keyof BrokerPermissions; label: string }> = [
  { key: "users", label: "Users" },
  { key: "kyc", label: "KYC review" },
  { key: "deposits", label: "Deposits" },
  { key: "withdrawals", label: "Withdrawals" },
  { key: "banks", label: "Bank accounts" },
  { key: "segment_settings", label: "Segment settings" },
  { key: "risk", label: "Risk management" },
  { key: "netting", label: "Netting overrides" },
  { key: "trading_view", label: "Trading view" },
  { key: "ledger", label: "Ledger" },
  { key: "reports", label: "Reports" },
  { key: "brokerage", label: "Brokerage" },
  { key: "sub_brokers", label: "Sub-brokers" },
];

const ALL_OFF: BrokerPermissions = {
  users: "OFF",
  kyc: "OFF",
  deposits: "OFF",
  withdrawals: "OFF",
  segment_settings: "OFF",
  risk: "OFF",
  netting: "OFF",
  trading_view: "OFF",
  ledger: "OFF",
  reports: "OFF",
  brokerage: "OFF",
  sub_brokers: "OFF",
  banks: "OFF",
};

const LEVEL_ORDER: Record<PermissionLevel, number> = { OFF: 0, VIEW: 1, EDIT: 2 };

function levelAllowed(cap: PermissionLevel, level: PermissionLevel): boolean {
  return LEVEL_ORDER[cap] >= LEVEL_ORDER[level];
}

export default function BrokersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.admin);
  // Broker actor creates sub-brokers under their own subtree; the backend
  // wires `broker_ancestry` automatically. Only the UI noun changes.
  const isBrokerActor = admin?.role === "BROKER";
  const noun = isBrokerActor ? "Sub-broker" : "Broker";
  const nounPlural = isBrokerActor ? "Sub-brokers" : "Brokers";
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [loginAsId, setLoginAsId] = useState<string | null>(null);

  // Cap drives the form greying — only fetched once per session.
  const { data: capRes } = useQuery({
    queryKey: ["admin", "brokers-cap"],
    queryFn: () => BrokerMgmtAPI.maxGrantable(),
    enabled: !!admin && admin.role !== "BROKER" ? true : !!admin?.broker_permissions,
  });
  const cap = (capRes?.cap ?? {}) as Record<keyof BrokerPermissions, PermissionLevel>;

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "brokers", q],
    queryFn: () => BrokerMgmtAPI.list({ q: q || undefined, page: 1, page_size: 100 }),
    enabled: !!admin,
    // Default 3-retry-with-backoff masquerades real errors as "slow loading"
    // — the broker list query is cheap, no flake retries needed. If it
    // fails, fail fast and let the error surface to the toast.
    retry: false,
  });

  const blockMut = useMutation({
    mutationFn: (id: string) => BrokerMgmtAPI.block(id),
    onSuccess: () => {
      toast.success(`${noun} blocked`);
      qc.invalidateQueries({ queryKey: ["admin", "brokers"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const unblockMut = useMutation({
    mutationFn: (id: string) => BrokerMgmtAPI.unblock(id),
    onSuccess: () => {
      toast.success(`${noun} unblocked`);
      qc.invalidateQueries({ queryKey: ["admin", "brokers"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  async function loginAs(broker: any) {
    setLoginAsId(broker.id);
    try {
      const r = await BrokerMgmtAPI.impersonate(broker.id);
      try {
        const prevAccess = window.localStorage.getItem(STORAGE_KEYS.accessToken);
        const prevRefresh = window.localStorage.getItem(STORAGE_KEYS.refreshToken);
        const prevAdmin = window.localStorage.getItem("nb.admin.auth");
        if (prevAccess && prevRefresh) {
          window.localStorage.setItem(
            "nb.admin.impersonatorSession",
            JSON.stringify({
              access: prevAccess,
              refresh: prevRefresh,
              admin: prevAdmin,
              ts: Date.now(),
            }),
          );
        }
      } catch {
        /* ignore */
      }
      setTokens(r.access_token, r.refresh_token);
      const next: AdminUser = {
        id: r.admin.id,
        user_code: r.admin.user_code,
        email: r.admin.email,
        full_name: r.admin.full_name,
        role: r.admin.role,
        last_login_at: null,
        admin_permissions: r.admin.admin_permissions ?? null,
        broker_permissions: r.admin.broker_permissions ?? null,
        pnl_share_pct: r.admin.pnl_share_pct ?? null,
      };
      useAdminAuthStore.setState({ admin: next });
      window.localStorage.setItem(
        "nb.admin.auth",
        JSON.stringify({ state: { admin: next }, version: 0 }),
      );
      qc.clear();
      toast.success(`Logged in as ${r.admin.user_code}`);
      router.push("/dashboard");
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || e.message || "Failed");
    } finally {
      setLoginAsId(null);
    }
  }

  // Permission gate: super-admin always; admin with `brokers`; broker with `sub_brokers >= VIEW`.
  const canManage =
    admin?.role === "SUPER_ADMIN" ||
    (admin?.role === "ADMIN" && !!admin.admin_permissions?.brokers) ||
    (admin?.role === "BROKER" &&
      !!admin.broker_permissions &&
      LEVEL_ORDER[admin.broker_permissions.sub_brokers] >= LEVEL_ORDER["VIEW"]);
  const canCreate =
    admin?.role === "SUPER_ADMIN" ||
    (admin?.role === "ADMIN" && !!admin.admin_permissions?.brokers) ||
    (admin?.role === "BROKER" &&
      !!admin.broker_permissions &&
      LEVEL_ORDER[admin.broker_permissions.sub_brokers] >= LEVEL_ORDER["EDIT"]);

  if (!canManage) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        You don't have permission to manage {nounPlural.toLowerCase()}.
      </div>
    );
  }

  const cols: Column<any>[] = [
    { key: "user_code", header: "Code" },
    { key: "full_name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "mobile", header: "Mobile" },
    {
      key: "pnl_share_pct",
      header: "PNL share %",
      render: (r) => `${r.pnl_share_pct ?? "0"}%`,
    },
    {
      key: "users",
      header: "Users",
      render: (r) => `${r.user_count} (${r.subtree_user_count} subtree)`,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span
          className={
            r.status === "ACTIVE"
              ? "rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500"
              : "rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-500"
          }
        >
          {r.status}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div
          className="flex justify-end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open actions"
                disabled={loginAsId === r.id}
              >
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => loginAs(r)}>
                <LogIn className="size-4 text-primary" />
                Login
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => router.push(`/management/brokers/${r.id}`)}
              >
                <Eye className="size-4" />
                View {noun.toLowerCase()} profile
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(r)}>
                <Pencil className="size-4" />
                Edit permissions
              </DropdownMenuItem>
              {r.status === "ACTIVE" ? (
                <DropdownMenuItem onSelect={() => blockMut.mutate(r.id)}>
                  <ShieldOff className="size-4 text-red-500" />
                  Block
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => unblockMut.mutate(r.id)}>
                  <ShieldCheck className="size-4 text-emerald-500" />
                  Unblock
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={nounPlural}
        actions={
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-10 w-56"
            />
            {canCreate && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New {noun.toLowerCase()}
              </Button>
            )}
          </div>
        }
      />

      <DataTable
        columns={cols}
        rows={data?.items}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        onRowClick={(r) => router.push(`/management/brokers/${r.id}`)}
      />

      <CreateBrokerDialog
        open={creating}
        onOpenChange={setCreating}
        cap={cap}
        noun={noun}
        onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "brokers"] })}
      />
      {editing && (
        <EditBrokerDialog
          broker={editing}
          cap={cap}
          noun={noun}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin", "brokers"] })}
        />
      )}
    </div>
  );
}

// ── Permission row (compact segmented control) ───────────────────────
//
// Layout: label on the left, 3-button segmented control on the right.
// Visual hierarchy:
//   OFF  → muted/grey (no permission, default)
//   VIEW → blue-ish (read-only)
//   EDIT → solid primary green (full access)
// Buttons above the actor's own cap are visibly disabled (40 % opacity +
// "not-allowed" cursor) and carry a tooltip so the user understands why.
function PermissionRow({
  label,
  cap,
  value,
  onChange,
}: {
  label: string;
  cap: PermissionLevel;
  value: PermissionLevel;
  onChange: (v: PermissionLevel) => void;
}) {
  const levels: Array<{ k: PermissionLevel; tone: string }> = [
    { k: "OFF", tone: "bg-muted text-foreground" },
    { k: "VIEW", tone: "bg-blue-500/15 text-blue-500" },
    { k: "EDIT", tone: "bg-primary text-primary-foreground" },
  ];
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm hover:bg-accent/40">
      <div className="text-foreground">{label}</div>
      <div className="flex shrink-0 overflow-hidden rounded border border-border">
        {levels.map(({ k: lv, tone }, idx) => {
          const allowed = levelAllowed(cap, lv);
          const active = value === lv;
          const sep = idx > 0 ? "border-l border-border" : "";
          return (
            <button
              key={lv}
              type="button"
              disabled={!allowed}
              title={
                !allowed
                  ? `Your cap is ${cap}; you can't grant ${lv}`
                  : undefined
              }
              onClick={() => onChange(lv)}
              className={
                `h-7 px-3 text-[11px] font-semibold uppercase tracking-wider transition-colors ${sep} ` +
                (active
                  ? tone
                  : allowed
                    ? "bg-background text-muted-foreground hover:bg-accent"
                    : "cursor-not-allowed bg-background text-muted-foreground opacity-40")
              }
            >
              {lv}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Bulk-set toolbar (Set all → OFF / VIEW / EDIT) — capped per key.
function BulkSetToolbar({
  cap,
  onApply,
}: {
  cap: Record<keyof BrokerPermissions, PermissionLevel>;
  onApply: (level: PermissionLevel) => void;
}) {
  const levels: PermissionLevel[] = ["OFF", "VIEW", "EDIT"];
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Quick set all:</span>
      {levels.map((lv) => (
        <button
          key={lv}
          type="button"
          onClick={() => onApply(lv)}
          className="rounded border border-border px-2 py-1 font-semibold uppercase tracking-wider hover:bg-accent"
        >
          {lv}
        </button>
      ))}
    </div>
  );
}

// Apply a bulk level to every permission, capping at each key's own ceiling.
function applyBulk(
  cap: Record<keyof BrokerPermissions, PermissionLevel>,
  level: PermissionLevel,
): BrokerPermissions {
  const next = { ...ALL_OFF };
  (Object.keys(next) as Array<keyof BrokerPermissions>).forEach((k) => {
    const ceiling = cap[k] ?? "OFF";
    // Clamp requested level down to the per-key cap.
    if (LEVEL_ORDER[level] <= LEVEL_ORDER[ceiling]) next[k] = level;
    else next[k] = ceiling;
  });
  return next;
}

// ── Create dialog ─────────────────────────────────────────────────────
function CreateBrokerDialog({
  open,
  onOpenChange,
  cap,
  noun,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cap: Record<keyof BrokerPermissions, PermissionLevel>;
  noun: string;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    mobile: "",
    password: "",
    pnl_share_pct: "0",
  });
  const [perms, setPerms] = useState<BrokerPermissions>({ ...ALL_OFF });
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (form.password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await BrokerMgmtAPI.create({
        full_name: form.full_name,
        email: form.email,
        mobile: form.mobile,
        password: form.password,
        permissions: perms as unknown as Record<string, "OFF" | "VIEW" | "EDIT">,
        pnl_share_pct: form.pnl_share_pct,
      });
      toast.success(`${noun} created`);
      onOpenChange(false);
      setForm({ full_name: "", email: "", mobile: "", password: "", pnl_share_pct: "0" });
      setPerms({ ...ALL_OFF });
      onCreated();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Layout: pinned header + scrollable body + pinned footer so a tall
        permissions list never pushes the basics/buttons off-screen on
        small viewports. `max-h-[90vh]` keeps the dialog inside the
        viewport; `flex flex-col` + `flex-1 overflow-y-auto` on the body
        makes the middle area scroll. We override DialogContent's
        default `p-6 gap-4` because we want section-specific padding now.
      */}
      <DialogContent className="flex max-h-[90vh] w-[95vw] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>New {noun.toLowerCase()}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 scrollbar-thin">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Mobile (10-digit)</Label>
              <Input value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>PNL share %</Label>
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.pnl_share_pct}
                onChange={(e) => setForm((f) => ({ ...f, pnl_share_pct: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Permissions</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">OFF</span> = hidden ·{" "}
                  <span className="font-semibold text-blue-500">VIEW</span> = read-only ·{" "}
                  <span className="font-semibold text-primary">EDIT</span> = full access
                </div>
              </div>
              <BulkSetToolbar cap={cap} onApply={(lv) => setPerms(applyBulk(cap, lv))} />
            </div>
            <div className="overflow-hidden rounded-md border border-border bg-background">
              <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <span>Section</span>
                <span>Access level</span>
              </div>
              <div className="divide-y divide-border">
                {PERMISSION_LABELS.map((p) => (
                  <PermissionRow
                    key={p.key}
                    label={p.label}
                    cap={cap[p.key] ?? "OFF"}
                    value={perms[p.key]}
                    onChange={(v) => setPerms((cur) => ({ ...cur, [p.key]: v }))}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading}>
            Create {noun.toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit dialog ──────────────────────────────────────────────────────
function EditBrokerDialog({
  broker,
  cap,
  noun,
  onClose,
  onSaved,
}: {
  broker: any;
  cap: Record<keyof BrokerPermissions, PermissionLevel>;
  noun: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [perms, setPerms] = useState<BrokerPermissions>({
    ...ALL_OFF,
    ...(broker.permissions || {}),
  });
  const [pnlPct, setPnlPct] = useState<string>(String(broker.pnl_share_pct ?? "0"));
  const [loading, setLoading] = useState(false);

  async function save() {
    setLoading(true);
    try {
      const res = await BrokerMgmtAPI.updatePermissions(
        broker.id,
        perms as unknown as Record<string, "OFF" | "VIEW" | "EDIT">,
      );
      await BrokerMgmtAPI.updatePnlShare(broker.id, pnlPct);
      const cascaded = res?.cascaded_changes ?? [];
      toast.success(
        cascaded.length > 0
          ? `Saved. ${cascaded.length} sub-broker(s) cascade-clipped.`
          : `${noun} updated`,
      );
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] w-[95vw] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>
            {broker.full_name}{" "}
            <span className="text-xs text-muted-foreground">{broker.user_code}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 scrollbar-thin">
          <div className="space-y-1.5">
            <Label>PNL share %</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={pnlPct}
              onChange={(e) => setPnlPct(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Permissions</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">OFF</span> = hidden ·{" "}
                  <span className="font-semibold text-blue-500">VIEW</span> = read-only ·{" "}
                  <span className="font-semibold text-primary">EDIT</span> = full access
                </div>
              </div>
              <BulkSetToolbar cap={cap} onApply={(lv) => setPerms(applyBulk(cap, lv))} />
            </div>
            <div className="overflow-hidden rounded-md border border-border bg-background">
              <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <span>Section</span>
                <span>Access level</span>
              </div>
              <div className="divide-y divide-border">
                {PERMISSION_LABELS.map((p) => (
                  <PermissionRow
                    key={p.key}
                    label={p.label}
                    cap={cap[p.key] ?? "OFF"}
                    value={perms[p.key]}
                    onChange={(v) => setPerms((cur) => ({ ...cur, [p.key]: v }))}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={loading}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

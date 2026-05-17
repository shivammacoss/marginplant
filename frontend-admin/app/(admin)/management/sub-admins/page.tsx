"use client";

import { useState } from "react";
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

import { ManagementAPI, setTokens } from "@/lib/api";
import { useAdminAuthStore } from "@/stores/authStore";
import { STORAGE_KEYS } from "@/lib/constants";
import type { AdminUser } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { AdminPermissions } from "@/types";

const PERMISSION_LABELS: Array<{ key: keyof AdminPermissions; label: string }> = [
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
  { key: "brokers", label: "Brokers (sub-admin can mint brokers)" },
];

const ALL_OFF: AdminPermissions = {
  users: false,
  kyc: false,
  deposits: false,
  withdrawals: false,
  banks: false,
  segment_settings: false,
  risk: false,
  netting: false,
  trading_view: false,
  ledger: false,
  reports: false,
  brokers: false,
  brokerage: false,
};

export default function SubAdminsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.admin);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [loginAsId, setLoginAsId] = useState<string | null>(null);

  // Same-origin localStorage means we can't keep both super-admin and sub-admin
  // sessions live in different tabs (both live under localhost:3001). So
  // "Login as" swaps the active session in this tab; we stash the prior
  // super-admin tokens under a dedicated key so a future "switch back" UI
  // can recover them. Until then the super-admin can just log out + log
  // back in to return to their own session. No confirm popup — super-admin
  // explicitly clicked the menu item, that's the confirmation.
  async function loginAs(sub: any) {
    setLoginAsId(sub.id);
    try {
      const r = await ManagementAPI.impersonateSubAdmin(sub.id);
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

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "sub-admins", q],
    queryFn: () => ManagementAPI.listSubAdmins({ q: q || undefined, page: 1, page_size: 100 }),
    enabled: admin?.role === "SUPER_ADMIN",
  });

  const blockMut = useMutation({
    mutationFn: (id: string) => ManagementAPI.blockSubAdmin(id),
    onSuccess: () => {
      toast.success("Sub-admin blocked");
      qc.invalidateQueries({ queryKey: ["admin", "sub-admins"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const unblockMut = useMutation({
    mutationFn: (id: string) => ManagementAPI.unblockSubAdmin(id),
    onSuccess: () => {
      toast.success("Sub-admin unblocked");
      qc.invalidateQueries({ queryKey: ["admin", "sub-admins"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (admin?.role !== "SUPER_ADMIN") {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        Only the super admin can manage sub-admins.
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
    { key: "user_count", header: "Users" },
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
        // Stop row-click navigation when the menu trigger is clicked —
        // otherwise tapping the dots would also open the detail page.
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
                onSelect={() => router.push(`/management/sub-admins/${r.id}`)}
              >
                <Eye className="size-4" />
                View admin profile
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
        title="Sub-admins"
        actions={
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-10 w-56"
            />
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New sub-admin
            </Button>
          </div>
        }
      />

      <DataTable
        columns={cols}
        rows={data?.items}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        onRowClick={(r) => router.push(`/management/sub-admins/${r.id}`)}
      />

      <CreateSubAdminDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "sub-admins"] })}
      />
      {editing && (
        <EditSubAdminDialog
          subAdmin={editing}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin", "sub-admins"] })}
        />
      )}
    </div>
  );
}

// ── Create dialog ─────────────────────────────────────────────────────
function CreateSubAdminDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    mobile: "",
    password: "",
    pnl_share_pct: "0",
  });
  const [perms, setPerms] = useState<AdminPermissions>({ ...ALL_OFF });
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (form.password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await ManagementAPI.createSubAdmin({
        full_name: form.full_name,
        email: form.email,
        mobile: form.mobile,
        password: form.password,
        permissions: perms as unknown as Record<string, boolean>,
        pnl_share_pct: form.pnl_share_pct,
      });
      toast.success("Sub-admin created");
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New sub-admin</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
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
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
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

        <div className="mt-4 space-y-2">
          <div className="text-sm font-medium">Permissions</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PERMISSION_LABELS.map((p) => (
              <label key={p.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={!!perms[p.key]}
                  onChange={(e) =>
                    setPerms((cur) => ({ ...cur, [p.key]: e.target.checked }))
                  }
                />
                {p.label}
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit dialog ────────────────────────────────────────────────────────
function EditSubAdminDialog({
  subAdmin,
  onClose,
  onSaved,
}: {
  subAdmin: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [perms, setPerms] = useState<AdminPermissions>({
    ...ALL_OFF,
    ...(subAdmin.permissions || {}),
  });
  const [pnlPct, setPnlPct] = useState<string>(String(subAdmin.pnl_share_pct ?? "0"));
  const [loading, setLoading] = useState(false);

  async function save() {
    setLoading(true);
    try {
      await ManagementAPI.updatePermissions(subAdmin.id, perms as unknown as Record<string, boolean>);
      await ManagementAPI.updatePnlShare(subAdmin.id, pnlPct);
      toast.success("Sub-admin updated");
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {subAdmin.full_name}{" "}
            <span className="text-xs text-muted-foreground">{subAdmin.user_code}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
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
          <div className="space-y-2">
            <div className="text-sm font-medium">Permissions</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={!!perms[p.key]}
                    onChange={(e) =>
                      setPerms((cur) => ({ ...cur, [p.key]: e.target.checked }))
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={loading}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";
import { UserActionMenu } from "@/components/admin/UserActionMenu";
import { OwnerBadge } from "@/components/admin/OwnerBadge";
import { useAdminAuthStore } from "@/stores/authStore";

export default function AdminUsersPage() {
  const me = useAdminAuthStore((s) => s.admin);
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "users", { q, role, status, page, pageSize }],
    queryFn: () =>
      UsersAPI.list({
        q: q || undefined,
        role: role || undefined,
        status: status || undefined,
        page,
        page_size: pageSize,
      }),
  });

  const columns: Column<any>[] = [
    { key: "user_code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.user_code}</span> },
    { key: "full_name", header: "Name" },
    { key: "email", header: "Email", className: "max-w-[260px] truncate" },
    { key: "mobile", header: "Mobile" },
    { key: "role", header: "Role", render: (r) => <StatusPill status={r.role} /> },
    { key: "owner", header: "Owner", render: (r) => <OwnerBadge row={r} me={me} /> },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end">
          <UserActionMenu user={r} />
        </div>
      ),
    },
  ];

  const total = data?.meta?.total ?? 0;
  const totalPages = data?.meta?.total_pages ?? 1;

  return (
    <div className="space-y-4">
      <PageHeader
        title="All users"
        description={`${total} users`}
        actions={
          <Button asChild>
            <Link href="/users/new">
              <Plus className="size-4" /> New user
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
            placeholder="Search code / email / mobile / name"
            className="pl-9"
          />
        </div>
        <select
          value={role}
          onChange={(e) => {
            setPage(1);
            setRole(e.target.value);
          }}
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All roles</option>
          <option value="CLIENT">Client</option>
          <option value="DEALER">Dealer</option>
          <option value="MASTER">Master</option>
          <option value="ADMIN">Admin</option>
          <option value="SUPER_ADMIN">Super admin</option>
        </select>
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PENDING">Pending</option>
          <option value="BLOCKED">Blocked</option>
          <option value="CLOSED">Closed</option>
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        empty="No users match the current filters."
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

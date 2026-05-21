"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LedgerAdminAPI, UsersAPI, ApiError } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  user:
    | {
        id: string;
        user_code?: string;
        full_name?: string;
        wallet?: { available_balance?: string | number };
      }
    | null;
}

function formatINR(v: unknown): string {
  const n = Number(v ?? 0);
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function LedgerSheet({ open, onClose, user }: Props) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [narration, setNarration] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "ledger", "user", user?.id],
    queryFn: () =>
      LedgerAdminAPI.list({ user_id: user!.id, page: 1, page_size: 200 }),
    enabled: !!user && open,
  });

  // Fetch fresh user detail so the balance tile reflects post-adjust state
  // without needing a parent reload. The parent passes a snapshot of the row
  // at click-time, which goes stale the moment we mutate the wallet.
  const { data: liveUser } = useQuery({
    queryKey: ["admin", "user", user?.id],
    queryFn: () => UsersAPI.detail(user!.id),
    enabled: !!user && open,
  });

  const liveBalance =
    liveUser?.wallet?.available_balance ?? user?.wallet?.available_balance;

  // Ledger sheet shows cash-flow rows: deposits, withdrawals, settlement-
  // outstanding events, and admin manual adjustments (Add/Deduct Fund,
  // bonus, penalty, promo). Trade-related rows (PNL / CHARGES / BROKERAGE)
  // live on the /ledger drill-down and the user's tradebook.
  const txns: any[] = (data?.items ?? []).filter((t: any) => {
    const tt = String(t?.transaction_type ?? "").toUpperCase();
    return (
      tt === "DEPOSIT" ||
      tt === "WITHDRAWAL" ||
      tt === "SETTLEMENT_OUTSTANDING_BOOKED" ||
      tt === "SETTLEMENT_OUTSTANDING_RECOVERY" ||
      tt === "ADJUSTMENT" ||
      tt === "BONUS" ||
      tt === "PENALTY" ||
      tt === "PROMO"
    );
  });

  const adjustMut = useMutation({
    mutationFn: ({
      signedAmount,
      narration,
    }: {
      signedAmount: number;
      narration: string;
    }) =>
      UsersAPI.walletAdjust(user!.id, {
        amount: signedAmount,
        narration,
        transaction_type: "ADJUSTMENT",
      }),
    onSuccess: () => {
      toast.success("Wallet adjusted");
      setAmount("");
      setNarration("");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "ledger", "user", user!.id] });
      qc.invalidateQueries({ queryKey: ["admin", "user", user!.id] });
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Adjustment failed";
      toast.error(msg);
    },
  });

  const submitAdjust = (direction: "add" | "deduct") => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Amount must be a positive number");
      return;
    }
    if (!narration.trim()) {
      toast.error("Narration is required");
      return;
    }
    const signed = direction === "add" ? n : -n;
    adjustMut.mutate({ signedAmount: signed, narration: narration.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Ledger — {user?.full_name || user?.user_code || ""}
          </DialogTitle>
          <DialogDescription>
            Wallet transactions and manual adjustments
          </DialogDescription>
        </DialogHeader>

        {/* Balance + adjust */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">
              Available balance
            </div>
            <div className="font-mono text-2xl font-bold mt-1">
              {formatINR(liveBalance)}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2">
            <div>
              <Label htmlFor="adjust-amount">Amount (₹)</Label>
              <Input
                id="adjust-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="adjust-narration">Narration</Label>
              <Input
                id="adjust-narration"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="Reason for adjustment"
              />
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => submitAdjust("add")}
                disabled={adjustMut.isPending}
              >
                {adjustMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Add Fund"
                )}
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                onClick={() => submitAdjust("deduct")}
                disabled={adjustMut.isPending}
              >
                Deduct Fund
              </Button>
            </div>
          </div>
        </div>

        {/* Ledger History summary */}
        {(() => {
          let totalDeposits = 0;
          let totalWithdrawals = 0;
          for (const t of txns) {
            const tt = String(t?.transaction_type ?? "").toUpperCase();
            const amt = Number(t?.amount ?? 0);
            if (tt === "DEPOSIT") {
              totalDeposits += Math.abs(amt);
            } else if (tt === "WITHDRAWAL") {
              totalWithdrawals += Math.abs(amt);
            } else if (
              tt === "ADJUSTMENT" ||
              tt === "BONUS" ||
              tt === "PROMO" ||
              tt === "PENALTY"
            ) {
              // Manual admin adjustments: positive → cash in, negative → cash out
              if (amt >= 0) totalDeposits += amt;
              else totalWithdrawals += Math.abs(amt);
            }
          }
          const net = totalDeposits - totalWithdrawals;
          return (
            <div className="mt-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-base">📊</span>
                <span className="font-semibold text-sm">Ledger History</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-profit/30 bg-profit/5 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Total Deposits
                  </div>
                  <div className="font-tabular text-lg font-bold text-profit mt-1">
                    {formatINR(totalDeposits)}
                  </div>
                </div>
                <div className="rounded-lg border border-loss/30 bg-loss/5 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Total Withdrawals
                  </div>
                  <div className="font-tabular text-lg font-bold text-loss mt-1">
                    {formatINR(totalWithdrawals)}
                  </div>
                </div>
                <div className="rounded-lg border border-info/30 bg-info/5 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Net Balance
                  </div>
                  <div className="font-tabular text-lg font-bold text-info mt-1">
                    {formatINR(net)}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Transactions list */}
        <div className="mt-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
            Recent transactions
          </div>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : txns.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No transactions yet.
            </div>
          ) : (
            <div className="space-y-1 max-h-[40vh] overflow-y-auto pr-1">
              {txns.map((t: any) => {
                const amt = Number(t.amount ?? 0);
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
                  >
                    <div className="flex flex-col leading-tight min-w-0">
                      <span className="font-medium">{t.transaction_type}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {t.narration || "—"}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {t.created_at
                          ? new Date(t.created_at).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <div
                      className={
                        amt >= 0
                          ? "font-mono font-semibold text-[#10b981] shrink-0"
                          : "font-mono font-semibold text-[#ef4444] shrink-0"
                      }
                    >
                      {formatINR(amt)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

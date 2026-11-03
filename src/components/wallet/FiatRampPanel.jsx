import React, { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { useLang } from "@/lib/LanguageContext";
import { cn } from "@/lib/utils";
import { CHAINS, fmtToken, txUrl } from "@/lib/chains";
import { Loader2, ChevronDown, Smartphone, CheckCircle2, XCircle, Clock, AlertTriangle, ArrowDownLeft, ArrowUpRight } from "lucide-react";

// Buy (onramp) / Sell (offramp) stablecoins against M-Pesa via Fingo Pay.
// All pricing and money movement happen server-side; this panel only shows a
// live estimate, submits the request and polls the ramp until it settles.

const FINAL = ["COMPLETED", "FAILED", "NEEDS_REVIEW"];

const STATUS_TEXT = {
  AWAITING_PAYMENT: "ramp.st.awaiting_payment",
  SENDING_CRYPTO: "ramp.st.sending_crypto",
  CRYPTO_SENT: "ramp.st.crypto_sent",
  AWAITING_CRYPTO: "ramp.st.awaiting_crypto",
  SENDING_PAYOUT: "ramp.st.sending_payout",
  PAYOUT_PENDING: "ramp.st.payout_pending",
  COMPLETED: "ramp.st.completed",
  FAILED: "ramp.st.failed",
  NEEDS_REVIEW: "ramp.st.needs_review",
};

function StatusIcon({ status, className }) {
  if (status === "COMPLETED") return <CheckCircle2 className={cn("text-emerald-400", className)} />;
  if (status === "FAILED") return <XCircle className={cn("text-rose-400", className)} />;
  if (status === "NEEDS_REVIEW") return <AlertTriangle className={cn("text-amber-400", className)} />;
  return <Loader2 className={cn("animate-spin text-cyan-300", className)} />;
}

export default function FiatRampPanel({ mode, onClose, onSettled }) {
  const { t } = useLang();
  const { toast } = useToast();
  const isBuy = mode === "buy";
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ amount: "", phone: "", chain: "bnb", token: "USDT" });
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState(null);
  const [history, setHistory] = useState([]);
  const pollRef = useRef(null);

  useEffect(() => {
    base44.functions.invoke("fingoRampStatus", { action: "config" }).then((r) => setCfg(r.data)).catch(() => setCfg({ available: false }));
    base44.functions.invoke("fingoRampStatus", { action: "list" }).then((r) => setHistory(r.data?.ramps || [])).catch(() => {});
    return () => clearTimeout(pollRef.current);
  }, []);

  // Poll the active ramp until it reaches a final state.
  useEffect(() => {
    clearTimeout(pollRef.current);
    if (!active || FINAL.includes(active.status)) return;
    pollRef.current = setTimeout(async () => {
      try {
        const r = await base44.functions.invoke("fingoRampStatus", { action: "status", rampId: active.id });
        const next = r.data?.ramp;
        if (next) {
          setActive(next);
          setHistory((h) => [next, ...h.filter((x) => x.id !== next.id)]);
          if (FINAL.includes(next.status)) onSettled?.(next);
        }
      } catch (_) {
        setActive((a) => (a ? { ...a } : a)); // retry on next tick
      }
    }, 4000);
    return () => clearTimeout(pollRef.current);
  }, [active, onSettled]);

  const amt = Number(form.amount) || 0;
  const rate = cfg?.kesPerUsd || 0;
  const fee = cfg?.feePct || 0;
  const estimate = isBuy
    ? Math.floor((amt / (rate || 1)) * (1 - fee / 100) * 100) / 100
    : Math.floor(amt * rate * (1 - fee / 100));

  const submit = async (e) => {
    e.preventDefault();
    if (!amt || !form.phone) {
      toast({ title: t("ramp.fill_fields"), variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const fn = isBuy ? "fingoOnramp" : "fingoOfframp";
      const payload = isBuy
        ? { kesAmount: amt, phoneNumber: form.phone, chain: form.chain, token: form.token }
        : { cryptoAmount: amt, phoneNumber: form.phone, chain: form.chain, token: form.token };
      const r = await base44.functions.invoke(fn, payload);
      const d = r.data;
      if (d?.error) {
        toast({ title: t("ramp.failed"), description: d.error, variant: "destructive" });
      } else {
        setActive(d.ramp);
        setHistory((h) => [d.ramp, ...h]);
        toast({ title: isBuy ? t("ramp.stk_sent") : t("ramp.sell_started") });
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message;
      toast({ title: t("ramp.failed"), description: msg, variant: "destructive" });
    }
    setSubmitting(false);
  };

  const Icon = isBuy ? ArrowDownLeft : ArrowUpRight;

  return (
    <div className="wallet-surface rounded-3xl p-5 text-white shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold">
          <Icon className="h-4 w-4 text-cyan-300" /> {isBuy ? t("ramp.buy_title") : t("ramp.sell_title")}
        </h3>
        <button onClick={onClose} className="rounded-md p-1 text-white/60 hover:bg-white/10"><ChevronDown className="h-4 w-4 rotate-180" /></button>
      </div>
      <p className="mt-1 text-xs text-white/50">{isBuy ? t("ramp.buy_desc") : t("ramp.sell_desc")}</p>

      {cfg && !cfg.available && (
        <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-300">{t("ramp.unavailable")}</p>
      )}
      {cfg?.sandbox && (
        <p className="mt-3 rounded-xl bg-cyan-500/10 p-2 text-center text-[11px] text-cyan-200">{t("ramp.sandbox")}</p>
      )}

      {active && (
        <div className="mt-4 rounded-2xl bg-white/5 p-4">
          <div className="flex items-start gap-3">
            <StatusIcon status={active.status} className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(STATUS_TEXT[active.status] || active.status)}</p>
              <p className="mt-0.5 text-xs text-white/60">
                {active.direction === "ONRAMP"
                  ? `KES ${fmtToken(active.kesAmount, 0)} → ${fmtToken(active.cryptoAmount, 2)} ${active.token}`
                  : `${fmtToken(active.cryptoAmount, 2)} ${active.token} → KES ${fmtToken(active.kesAmount, 0)}`}
              </p>
              {active.message && <p className="mt-1 text-xs text-white/40">{active.message}</p>}
              {active.processorReference && <p className="mt-1 text-xs text-white/50">M-Pesa: {active.processorReference}</p>}
              {active.cryptoTxHash && (
                <a href={txUrl(active.chain, active.cryptoTxHash)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-cyan-300 underline">{t("ramp.view_tx")}</a>
              )}
            </div>
          </div>
          {FINAL.includes(active.status) && (
            <Button size="sm" variant="ghost" className="mt-3 w-full text-white hover:bg-white/10" onClick={() => { setActive(null); setForm((f) => ({ ...f, amount: "" })); }}>
              {t("ramp.new")}
            </Button>
          )}
        </div>
      )}

      {!active && (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-white/60">{t("wallet.chain")}</Label>
              <select className="h-9 w-full rounded-md border border-white/10 bg-white/5 px-2 text-sm text-white" value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })}>
                {CHAINS.map((c) => <option key={c.key} value={c.key} className="text-black">{c.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-white/60">{t("wallet.token")}</Label>
              <select className="h-9 w-full rounded-md border border-white/10 bg-white/5 px-2 text-sm text-white" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}>
                <option value="USDT" className="text-black">USDT</option>
                <option value="USDC" className="text-black">USDC</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-white/60">{isBuy ? t("ramp.you_pay_kes") : t("ramp.you_sell", { token: form.token })}</Label>
            <Input type="number" step={isBuy ? "1" : "0.01"} min="0" glow={false} background="rgba(255,255,255,0.05)" placeholder={isBuy ? "1000" : "10.00"} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="border-white/10 text-white placeholder:text-white/30" />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs text-white/60"><Smartphone className="h-3.5 w-3.5" /> {t("ramp.mpesa_number")}</Label>
            <Input type="tel" glow={false} background="rgba(255,255,255,0.05)" placeholder="07XX XXX XXX" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border-white/10 text-white placeholder:text-white/30" />
          </div>

          {cfg?.available && (
            <div className="space-y-1 rounded-xl bg-white/5 p-3 text-xs">
              <div className="flex justify-between text-white/50"><span>{t("ramp.rate")}</span><span>1 USD ≈ KES {fmtToken(rate, 2)}</span></div>
              <div className="flex justify-between text-white/50"><span>{t("ramp.fee")}</span><span>{fmtToken(fee, 2)}%</span></div>
              <div className="flex justify-between pt-1 text-sm font-semibold text-white">
                <span>{t("ramp.you_receive")}</span>
                <span>{amt > 0 ? (isBuy ? `≈ ${fmtToken(estimate, 2)} ${form.token}` : `≈ KES ${fmtToken(estimate, 0)}`) : "—"}</span>
              </div>
              {cfg.limits && (
                <p className="pt-1 text-[11px] text-white/40">
                  {t("ramp.limits", { min: cfg.limits.chargeMinKes, max: fmtToken(cfg.limits.chargeMaxKes, 0) })}
                </p>
              )}
            </div>
          )}

          <Button type="submit" className="w-full btn-heat" disabled={submitting || !cfg?.available}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}
            {isBuy ? t("ramp.buy_cta") : t("ramp.sell_cta")}
          </Button>
        </form>
      )}

      {history.filter((h) => h.id !== active?.id).length > 0 && (
        <div className="mt-5">
          <p className="pb-2 text-xs font-semibold uppercase tracking-wide text-white/40">{t("ramp.recent")}</p>
          <div className="space-y-1.5">
            {history.filter((h) => h.id !== active?.id).slice(0, 5).map((h) => (
              <button key={h.id} type="button" onClick={() => setActive(h)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/5">
                {FINAL.includes(h.status) ? <StatusIcon status={h.status} className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0 text-amber-300" />}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{h.direction === "ONRAMP" ? t("ramp.bought") : t("ramp.sold")} {fmtToken(h.cryptoAmount, 2)} {h.token}</p>
                  <p className="text-[11px] text-white/40">{new Date(h.createdAt).toLocaleString()} · {t(STATUS_TEXT[h.status] || h.status)}</p>
                </div>
                <span className="text-xs font-mono text-white/70">KES {fmtToken(h.kesAmount, 0)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useWallet } from "@/lib/useWallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { useLang } from "@/lib/LanguageContext";
import { CHAINS, getChain, fmtToken, shortAddr, txUrl, TOKEN_LOGOS, fetchCoinGeckoToken } from "@/lib/chains";
import { friendlyWalletError } from "@/lib/walletErrors";
import CryptoLogo from "@/components/ui/CryptoLogo";
import WithdrawalReceipt from "@/components/WithdrawalReceipt";
import AddCustomToken from "@/components/wallet/AddCustomToken";
import FiatRampPanel from "@/components/wallet/FiatRampPanel";
import {
  Copy, RefreshCw, ArrowUpRight, Loader2, Plus,
  ExternalLink, ShieldCheck, ArrowDownToLine, Eye, EyeOff,
  ChevronDown, History, QrCode, Send as SendIcon, Wallet as WalletIcon,
  Ticket, Heart, Trophy, Gem, TrendingUp, Award, Banknote, HandCoins,
} from "lucide-react";

// Transaction type → display label, badge icon, and amount sign/colour.
const TX_META = {
  DEPOSIT:      { labelKey: "wallet.tx.received",   icon: ArrowDownToLine, positive: true },
  WITHDRAW:     { labelKey: "wallet.tx.sent",       icon: ArrowUpRight,    positive: false },
  LOTTERY_BUY:  { labelKey: "wallet.tx.ticket",     icon: Ticket,          positive: false },
  DONATION:     { labelKey: "wallet.tx.donation",   icon: Heart,            positive: false },
  PRIZE_PAYOUT: { labelKey: "wallet.tx.prize",      icon: Trophy,          positive: true },
  GOV_MINT:     { labelKey: "wallet.tx.gov_mint",   icon: Gem,              positive: true },
  GOV_PURCHASE: { labelKey: "wallet.tx.gov_buy",    icon: Gem,              positive: false },
  GOV_SALE:     { labelKey: "wallet.tx.gov_sale",   icon: Gem,              positive: true },
  REFERRAL:     { labelKey: "wallet.tx.referral",   icon: TrendingUp,       positive: true },
  FEE:          { labelKey: "wallet.tx.fee",        icon: ArrowUpRight,    positive: false },
  GAS:          { labelKey: "wallet.tx.gas",        icon: ArrowUpRight,    positive: false },
  RAMP_BUY:     { labelKey: "wallet.tx.ramp_buy",   icon: Banknote,        positive: true },
  RAMP_SELL:    { labelKey: "wallet.tx.ramp_sell",  icon: HandCoins,       positive: false },
};

// Groups an ordered transaction list into date buckets ("Today", "Yesterday",
// "Sep 14, 2026") preserving the original (newest-first) order.
function groupTxByDate(list, t) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = [];
  const byLabel = {};
  for (const tx of list) {
    const d = new Date(tx.createdAt);
    const startTx = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((startToday - startTx) / 86400000);
    const label = diff === 0 ? t("wallet.today") : diff === 1 ? t("wallet.yesterday") : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!byLabel[label]) { byLabel[label] = []; buckets.push(label); }
    byLabel[label].push(tx);
  }
  return buckets.map((label) => ({ label, items: byLabel[label] }));
}

export default function CryptoWallet() {
  const { user, wallet, loading, refresh } = useWallet();
  const { t } = useLang();
  const { toast } = useToast();
  const [balances, setBalances] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyingTx, setVerifyingTx] = useState(false);
  const [txs, setTxs] = useState([]);
  const [form, setForm] = useState({ chain: "bnb", token: "USDT", amount: "", toAddress: "" });
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState("assets");
  const [panel, setPanel] = useState(null);
  const [showAllTxs, setShowAllTxs] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [customAssets, setCustomAssets] = useState([]);

  const address = wallet?.walletAddress;

  const loadTxs = async () => {
    if (!user) return;
    try {
      const list = await base44.entities.CryptoTransaction.filter({ userId: user.id }, "-createdAt", 20);
      setTxs(list);
    } catch (_) {}
  };

  const sync = async (silent = false) => {
    if (!silent) setSyncing(true);
    try {
      const res = await base44.functions.invoke("getWalletBalances", {});
      const d = res.data;
      if (d?.needsWallet) {
        if (!silent) toast({ title: t("wallet.create_first") });
      } else if (d?.error) {
        if (!silent) toast({ title: t("wallet.sync_failed"), description: d.error, variant: "destructive" });
      } else {
        setBalances(d.chains);
        setCustomAssets(d.custom || []);
        // Enrich custom tokens with CoinGecko logo + USD price (client-side).
        // Fetch in parallel; falls back to nulls silently on any failure.
        Promise.all((d.custom || []).map(async (ct) => {
          try {
            const cg = await fetchCoinGeckoToken(ct.chain, ct.address);
            return { ...ct, logo: ct.logo || cg.logo, priceUsd: ct.priceUsd ?? cg.priceUsd };
          } catch (_) { return ct; }
        })).then((enriched) => setCustomAssets(enriched));
        if (!silent) toast({ title: t("wallet.synced") });
      }
    } catch (e) {
      if (!silent) toast({ ...friendlyWalletError(e, "Sync failed"), variant: "destructive" });
    }
    if (!silent) setSyncing(false);
  };

  const verifyDeposits = async (silent = false) => {
    if (!silent) setVerifying(true);
    try {
      const res = await base44.functions.invoke("verifyDeposits", {});
      const d = res.data;
      if (d?.needsWallet) {
        if (!silent) toast({ title: t("wallet.create_first") });
      } else if (d?.error) {
        if (!silent) toast({ title: t("wallet.verify_failed"), description: d.error, variant: "destructive" });
      } else {
        if (!silent) {
          toast({
            title: t("wallet.deposits_verified"),
            description: t("wallet.deposits_desc", { new: d.newDeposits || 0, total: d.confirmed || 0 }),
          });
        }
        loadTxs();
        sync(silent);
      }
    } catch (e) {
      if (!silent) toast({ ...friendlyWalletError(e, "Verification failed"), variant: "destructive" });
    }
    if (!silent) setVerifying(false);
  };

  const verifyTxStatus = async (silent = false) => {
    setVerifyingTx(true);
    try {
      const res = await base44.functions.invoke("verifyTransactions", {});
      const d = res.data;
      if (d?.error) {
        if (!silent) toast({ title: t("wallet.verify_failed"), description: d.error, variant: "destructive" });
      } else if ((d.updated || 0) > 0) {
        toast({ title: t("wallet.tx_updated"), description: t("wallet.tx_updated_desc", { n: d.updated }) });
        loadTxs();
      } else if (!silent) {
        toast({ title: t("wallet.tx_pending") });
      }
    } catch (e) {
      if (!silent) toast({ ...friendlyWalletError(e, "Verification failed"), variant: "destructive" });
    }
    setVerifyingTx(false);
  };

  const createWallet = async () => {
    setCreating(true);
    try {
      const res = await base44.functions.invoke("createWallet", {});
      const d = res.data;
      if (d?.error) {
        toast({ title: t("wallet.failed"), description: d.error, variant: "destructive" });
      } else {
        toast({ title: t("wallet.wallet_created"), description: shortAddr(d.address) });
        await refresh();
        sync();
      }
    } catch (e) {
      toast({ ...friendlyWalletError(e, "Wallet creation failed"), variant: "destructive" });
    }
    setCreating(false);
  };

  const withdraw = async (e) => {
    e.preventDefault();
    if (!form.toAddress || !form.amount) {
      toast({ title: t("wallet.enter_amt_dest"), variant: "destructive" });
      return;
    }
    // Snapshot the request so the receipt still has the values after the form resets.
    const { amount, token, chain, toAddress } = form;
    setWithdrawing(true);
    let success = false;
    let txHash = null;
    let errMsg = null;
    try {
      const res = await base44.functions.invoke("withdrawCrypto", form);
      const d = res.data;
      if (d?.error) {
        errMsg = d.error;
        toast({ title: t("wallet.withdraw_failed"), description: d.error, variant: "destructive" });
      } else {
        success = true;
        txHash = d.txHash;
        toast({ title: t("wallet.withdraw_broadcast"), description: shortAddr(d.txHash) });
        setForm({ chain: "bnb", token: "USDT", amount: "", toAddress: "" });
        setPanel(null);
        loadTxs();
        setTimeout(sync, 5000);
      }
    } catch (e) {
      errMsg = e.message;
      toast({ ...friendlyWalletError(e, "Withdrawal failed"), variant: "destructive" });
    }
    setWithdrawing(false);

    // Email the receipt to the user (success OR failure) and show the on-screen
    // receipt modal. A backend failure here shouldn't block the modal.
    let paymentOrderId, date;
    try {
      const r = await base44.functions.invoke("sendWithdrawalReceipt", {
        success, amount, token, chain, txHash, toAddress, error: errMsg,
      });
      paymentOrderId = r.data?.paymentOrderId;
      date = r.data?.date;
    } catch (_) {}
    setReceipt({
      status: success ? "success" : "failed",
      amount, token, chain, txHash, toAddress,
      paymentOrderId, date: date || new Date().toISOString(), error: errMsg,
    });
  };

  // Refresh balances/activity once a Fingo ramp settles.
  const onRampSettled = React.useCallback(() => {
    loadTxs();
    setTimeout(() => sync(true), 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const copy = (text) => {
    navigator.clipboard.writeText(text);
    toast({ title: t("wallet.copied") });
  };

  const removeCustomToken = async (ctChain, ctAddress) => {
    try {
      const res = await base44.functions.invoke("manageCustomToken", { action: "remove", chain: ctChain, address: ctAddress });
      const d = res.data;
      if (d?.error) {
        toast({ title: t("wallet.could_not_remove"), description: d.error, variant: "destructive" });
      } else {
        toast({ title: t("wallet.token_removed") });
        sync(true);
      }
    } catch (e) {
      toast({ title: t("wallet.could_not_remove"), description: e.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    if (address) {
      sync(true);
      verifyDeposits(true);
    }
    loadTxs();
    verifyTxStatus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const balanceOf = (chainKey, sym) => {
    const c = balances?.find((b) => b.chain === chainKey);
    return c?.balances?.[sym] ?? null;
  };

  const totalUsdc = (balances || []).reduce((s, c) => s + (Number(c.balances?.USDC) || 0), 0);
  const totalUsdt = (balances || []).reduce((s, c) => s + (Number(c.balances?.USDT) || 0), 0);
  const totalUSD = totalUsdc + totalUsdt;
  const mask = (v) => (hidden ? "••••••" : v);

  // Flat asset rows (aggregated by token like the reference UI), sorted by
  // USD value descending. Gas tokens have no USD price so they sink to the end.
  const builtInRows = [
    { key: "USDC", name: "USD Coin", sym: "USDC", logo: TOKEN_LOGOS.USDC, price: 1, qty: totalUsdc, chain: "Stablecoin" },
    { key: "USDT", name: "Tether", sym: "USDT", logo: TOKEN_LOGOS.USDT, price: 1, qty: totalUsdt, chain: "Stablecoin" },
    ...CHAINS.map((c) => ({
      key: c.key, name: c.native, sym: c.native, logo: c.nativeLogo, price: null, qty: balanceOf(c.key, "native"), chain: `Gas · ${c.name}`,
    })),
  ].sort((a, b) => {
    const av = a.price != null && a.qty != null ? a.qty * a.price : -1;
    const bv = b.price != null && b.qty != null ? b.qty * b.price : -1;
    return bv - av;
  });
  const customRows = (customAssets || []).map((ct) => ({
    key: `custom-${ct.chain}-${ct.address}`,
    name: ct.name || ct.symbol,
    sym: ct.symbol,
    logo: ct.logo || null,
    price: ct.priceUsd != null ? Number(ct.priceUsd) : null,
    qty: ct.balance != null ? Number(ct.balance) : null,
    chain: `Custom · ${getChain(ct.chain)?.name || ct.chain}`,
    custom: true,
    ctChain: ct.chain,
    ctAddress: ct.address,
  }));
  const assetRows = [...builtInRows, ...customRows];

  // Glassmorphic action pill
  const Pill = ({ icon: Icon, label, onClick, busy }) => (
    <button onClick={onClick} className="flex flex-1 items-center justify-center gap-2 rounded-full glass-pill py-3 text-sm font-semibold text-white transition-colors hover:bg-white/25 btn-heat">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-lg space-y-4">
      {/* Hero */}
      {!loading && address && (
        <div className="relative overflow-hidden rounded-3xl wallet-hero-gradient p-5 text-white shadow-xl">
          <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-white/20 blur-3xl" />
          {/* Header row */}
          <div className="relative flex items-center justify-between">
            <button onClick={() => copy(address)} title={t("wallet.copy_address")} className="inline-flex items-center gap-1.5 rounded-full glass-pill px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/25">
              <WalletIcon className="h-3.5 w-3.5" /> {t("wallet.main_wallet")}
            </button>
            <button onClick={() => setHidden((h) => !h)} className="rounded-full glass-pill p-2 text-white transition-colors hover:bg-white/25">
              {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {/* Balance */}
          <div className="relative mt-5">
            <p className="text-xs font-medium uppercase tracking-widest text-white/70">{t("wallet.total_balance")}</p>
            <p className="mt-1 text-4xl font-bold tracking-tight">{mask(`$${fmtToken(totalUSD, 2)}`)}</p>
            <div className="mt-2 flex items-center gap-2">
              <button onClick={() => copy(address)} title={t("wallet.copy_address")} className="text-sm font-medium text-cyan-50/90 transition-colors hover:text-white">{mask(shortAddr(address))}</button>
              <button onClick={() => copy(address)} className="rounded p-1 text-white/70 hover:bg-white/15 hover:text-white" title={t("wallet.copy")}><Copy className="h-3.5 w-3.5" /></button>
              <a href={`${getChain("bnb")?.explorer}/address/${address}`} target="_blank" rel="noreferrer" className="rounded p-1 text-white/70 hover:bg-white/15 hover:text-white">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          {/* Action pills */}
          <div className="relative mt-5 flex gap-2.5">
            <Pill icon={ArrowDownToLine} label={t("wallet.receive")} onClick={() => setPanel(panel === "receive" ? null : "receive")} />
            <Pill icon={SendIcon} label={t("wallet.send")} onClick={() => setPanel(panel === "send" ? null : "send")} />
            <Pill icon={RefreshCw} label={t("wallet.sync")} onClick={() => sync(true)} />
          </div>
          <div className="relative mt-2.5 flex gap-2.5">
            <Pill icon={Banknote} label={t("ramp.buy")} onClick={() => setPanel(panel === "buy" ? null : "buy")} />
            <Pill icon={HandCoins} label={t("ramp.sell")} onClick={() => setPanel(panel === "sell" ? null : "sell")} />
          </div>
        </div>
      )}

      {loading && (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* No wallet */}
      {!loading && !address && (
        <div className="rounded-3xl border border-dashed border-border bg-card p-10 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full wallet-hero-gradient text-white">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">{t("wallet.no_wallet_title")}</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t("wallet.no_wallet_desc")}
          </p>
          <Button className="mt-5 btn-heat" onClick={createWallet} disabled={creating}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            {t("wallet.generate")}
          </Button>
        </div>
      )}

      {/* Receive / Send panels */}
      {!loading && address && panel === "receive" && (
        <div className="wallet-surface rounded-3xl p-5 text-white shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold"><ArrowDownToLine className="h-4 w-4 text-cyan-300" /> {t("wallet.receive")}</h3>
            <button onClick={() => setPanel(null)} className="rounded-md p-1 text-white/60 hover:bg-white/10"><ChevronDown className="h-4 w-4 rotate-180" /></button>
          </div>
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="rounded-2xl bg-white p-3">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&bgcolor=ffffff&data=${encodeURIComponent(address)}`}
                alt={t("wallet.deposit_qr")}
                className="h-40 w-40"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            </div>
            <div className="flex w-full items-center gap-2 rounded-xl bg-white/5 p-2.5">
              <code className="flex-1 truncate text-xs text-white/80">{address}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(address)}><Copy className="h-3.5 w-3.5 text-white" /></Button>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {CHAINS.map((c) => (
                <Badge key={c.key} variant="secondary" className="gap-1.5">
                  <CryptoLogo src={c.logo} alt={c.name} color={c.color} className="h-3.5 w-3.5" /> {c.name}
                </Badge>
              ))}
            </div>
            <p className="text-center text-xs text-amber-400">
              {t("wallet.warning_chain")}
            </p>
          </div>
        </div>
      )}

      {!loading && address && panel === "send" && (
        <div className="wallet-surface rounded-3xl p-5 text-white shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold"><SendIcon className="h-4 w-4 text-cyan-300" /> {t("wallet.send")}</h3>
            <button onClick={() => setPanel(null)} className="rounded-md p-1 text-white/60 hover:bg-white/10"><ChevronDown className="h-4 w-4 rotate-180" /></button>
          </div>
          <form onSubmit={withdraw} className="mt-4 space-y-3">
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
                  <option value="USDC" className="text-black">USDC</option>
                  <option value="USDT" className="text-black">USDT</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-white/60">{t("wallet.amount")}</Label>
              <Input type="number" step="any" min="0" glow={false} background="rgba(255,255,255,0.05)" placeholder="0.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="border-white/10 text-white placeholder:text-white/30" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-white/60">{t("wallet.destination")}</Label>
              <Input glow={false} background="rgba(255,255,255,0.05)" placeholder="0x…" value={form.toAddress} onChange={(e) => setForm({ ...form, toAddress: e.target.value })} className="border-white/10 text-white placeholder:text-white/30" />
            </div>
            <Button type="submit" className="w-full btn-heat" disabled={withdrawing}>
              {withdrawing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <SendIcon className="mr-2 h-4 w-4" />}
              {t("wallet.withdraw")}
            </Button>
          </form>
        </div>
      )}

      {!loading && address && (panel === "buy" || panel === "sell") && (
        <FiatRampPanel
          key={panel}
          mode={panel}
          onClose={() => setPanel(null)}
          onSettled={onRampSettled}
        />
      )}

      {/* Agent earnings (referral + winning bonus) — ledger-tracked in the
          platform custody wallet, surfaced here so agents see what they've earned. */}
      {!loading && address && (Number(wallet?.totalReferralEarnings) > 0 || Number(wallet?.totalBonusEarnings) > 0) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><TrendingUp className="h-4 w-4" /></div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("wallet.referral")}</p>
            </div>
            <p className="mt-2 text-xl font-bold">{fmtToken(Number(wallet?.totalReferralEarnings) || 0, 2)} <span className="text-xs font-medium text-muted-foreground">USD</span></p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent"><Award className="h-4 w-4" /></div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("wallet.winning_bonus")}</p>
            </div>
            <p className="mt-2 text-xl font-bold">{fmtToken(Number(wallet?.totalBonusEarnings) || 0, 2)} <span className="text-xs font-medium text-muted-foreground">USD</span></p>
          </div>
        </div>
      )}

      {/* Tab bar (dark) */}
      {!loading && address && (
        <div className="flex gap-1 rounded-full wallet-surface p-1">
          {[
            { k: "assets", label: t("wallet.assets"), icon: QrCode },
            { k: "activity", label: t("wallet.activity"), icon: History },
          ].map((tb) => (
            <button key={tb.k} onClick={() => setTab(tb.k)}
              className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium transition-colors",
                tab === tb.k ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70")}>
              <tb.icon className="h-4 w-4" /> {tb.label}
            </button>
          ))}
        </div>
      )}

      {/* Assets: dark list */}
      {!loading && address && tab === "assets" && (
        <>
          <div className="wallet-surface overflow-hidden rounded-3xl shadow-sm">
            <div className="divide-y divide-white/5">
              {assetRows.map((a) => {
                const qty = a.qty;
                const value = a.price != null && qty != null ? qty * a.price : null;
                return (
                  <div
                    key={a.key}
                    onClick={a.custom ? undefined : () => copy(address)}
                    title={a.custom ? t("wallet.custom_token") : t("wallet.tap_copy")}
                    className={cn("flex items-center gap-3 px-4 py-3.5 transition-colors", a.custom ? "" : "cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06]")}
                  >
                    <div className="shrink-0 rounded-full transition-transform hover:scale-110 active:scale-95">
                      <CryptoLogo src={a.logo} alt={a.name} color="#627EEA" className="h-10 w-10" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white">{a.name} <span className="text-white/40">{a.sym}</span></p>
                      <p className="text-xs text-white/40">
                        {a.custom
                          ? (a.price != null ? `$${fmtToken(a.price, a.price >= 1 ? 2 : 4)}` : a.chain)
                          : (a.price != null ? `$${fmtToken(a.price, 2)} · 0.00%` : a.chain)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-white">{qty === null ? "—" : mask(fmtToken(qty, 4))}</p>
                      {a.custom ? (
                        <div className="flex items-center justify-end gap-2">
                          <p className="text-xs text-white/40">{value === null ? "—" : mask(`$${fmtToken(value, 2)}`)}</p>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeCustomToken(a.ctChain, a.ctAddress); }}
                            className="text-xs text-white/40 transition-colors hover:text-rose-400"
                            >
                            {t("wallet.remove")}
                            </button>
                        </div>
                      ) : (
                        <p className="text-xs text-white/40">{value === null ? "—" : mask(`$${fmtToken(value, 2)}`)}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <AddCustomToken onAdded={() => sync(true)} />
        </>
      )}

      {/* Activity */}
      {!loading && address && tab === "activity" && (
        <div className="wallet-surface overflow-hidden rounded-3xl shadow-sm">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><History className="h-4 w-4 text-cyan-300" /> {t("wallet.recent_activity")}</h3>
            <button onClick={() => verifyTxStatus()} disabled={verifyingTx} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10">
              {verifyingTx ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t("wallet.verify")}
            </button>
          </div>
          {txs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-white/40">{t("wallet.no_txs")}</p>
          ) : (
            <div className="px-3 pb-2">
              {groupTxByDate(showAllTxs ? txs : txs.slice(0, 4), t).map((g) => (
                <div key={g.label} className="pt-3 first:pt-1">
                  <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-white/40">{g.label}</p>
                  <div className="space-y-1">
                    {g.items.map((tr) => {
                      const meta = TX_META[tr.type] || { labelKey: tr.type, icon: ArrowUpRight, positive: false };
                      const sign = meta.positive ? "+" : "-";
                      const time = new Date(tr.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                      return (
                        <div key={tr.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.03]">
                          <div className="relative shrink-0">
                            <CryptoLogo src={TOKEN_LOGOS[tr.token]} alt={tr.token} className="h-10 w-10 rounded-full" />
                            <span className={cn("absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-[#07090f] text-white",
                              meta.positive ? "bg-emerald-500" : "bg-rose-500")}>
                              <meta.icon className="h-2.5 w-2.5" strokeWidth={2.5} />
                            </span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-white">{t(meta.labelKey)}</p>
                            <p className="flex items-center gap-1.5 text-xs text-white/40">
                              {tr.txHash
                                ? <a href={txUrl(tr.chain, tr.txHash)} target="_blank" rel="noreferrer" className="underline decoration-white/20 hover:text-white/70">{time} · {tr.chain}</a>
                                : <span>{time} · {tr.chain}</span>}
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold",
                                tr.status === "CONFIRMED" ? "bg-emerald-500/15 text-emerald-300" : tr.status === "FAILED" ? "bg-rose-500/15 text-rose-400" : "bg-amber-500/15 text-amber-300")}>
                                {tr.status === "CONFIRMED" ? t("wallet.success") : tr.status === "FAILED" ? t("wallet.failed_badge") : t("wallet.pending_badge")}
                              </span>
                            </p>
                          </div>
                          <div className="text-right">
                            <p className={cn("font-mono text-sm font-semibold", meta.positive ? "text-emerald-400" : "text-rose-400")}>
                              {sign}{fmtToken(tr.amount, 2)} {tr.token}
                            </p>
                            <p className="text-xs text-white/40">≈${fmtToken(tr.amount, 2)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {txs.length > 4 && (
            <button onClick={() => setShowAllTxs((s) => !s)} className="flex w-full items-center justify-center gap-1.5 border-t border-white/5 py-3 text-sm font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white">
              {showAllTxs ? <><ChevronDown className="h-4 w-4 rotate-180" /> {t("wallet.show_less")}</> : <><ChevronDown className="h-4 w-4" /> {t("wallet.show_more", { n: txs.length - 4 })}</>}
            </button>
          )}
        </div>
      )}

      <WithdrawalReceipt open={!!receipt} receipt={receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}
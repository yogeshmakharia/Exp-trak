import React, { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  deleteDoc,
  doc,
  updateDoc,
} from "firebase/firestore";

/**
 * Shared Expense + Rent Split (3 users)
 * - Records: Legal expenses, Other expenses, Rental income
 * - Tracks: who paid/received, how to split (default 1/3 each), outstanding balances
 * - Multi-user: Firebase Auth + Firestore (real-time)
 *
 * SETUP (10 minutes)
 * 1) Create Firebase project: https://console.firebase.google.com
 * 2) Add Web App -> copy config into FIREBASE_CONFIG below
 * 3) Enable Authentication -> Email/Password
 * 4) Create Firestore Database (production or test)
 * 5) Firestore rules: start with "test mode" for quick trial; later tighten
 *
 * OPTIONAL: Pre-create 3 accounts (one per brother) using the Sign Up tab here.
 */

const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const BROTHERS = [
  { id: "b1", label: "Brother 1" },
  { id: "b2", label: "Brother 2" },
  { id: "b3", label: "Brother 3" },
];

const TYPE_OPTIONS = [
  { value: "expense_legal", label: "Legal expense" },
  { value: "expense_other", label: "Other expense" },
  { value: "income_rent", label: "Rental income" },
];

function currency(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "₹0";
  return x.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function computeLedger(items) {
  // Convention: positive balance = person is owed money; negative = person owes.
  const bal = { b1: 0, b2: 0, b3: 0 };

  for (const it of items) {
    const amount = Number(it.amount || 0);
    if (!amount) continue;

    // Effective split shares (sum to 1). Default 1/3 each.
    const shares = it.shares || { b1: 1 / 3, b2: 1 / 3, b3: 1 / 3 };

    if (it.kind === "income_rent") {
      // Income: receiver gets +amount; then distribute cost (negative) by shares so each should have received their share.
      // If one brother received all rent, others are owed their share.
      bal[it.payer] += amount;
      for (const bid of Object.keys(bal)) {
        bal[bid] -= amount * (shares[bid] ?? 0);
      }
    } else {
      // Expense: payer paid amount => +amount; then allocate expense share to each (negative) so each owes their share.
      bal[it.payer] += amount;
      for (const bid of Object.keys(bal)) {
        bal[bid] -= amount * (shares[bid] ?? 0);
      }
    }
  }

  return bal;
}

function suggestedSettlements(bal) {
  // Greedy settlement recommendations.
  const debtors = [];
  const creditors = [];
  for (const [k, v] of Object.entries(bal)) {
    if (v < -1) debtors.push({ id: k, amt: -v });
    else if (v > 1) creditors.push({ id: k, amt: v });
  }
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);

  const pays = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const x = Math.min(d.amt, c.amt);
    pays.push({ from: d.id, to: c.id, amount: x });
    d.amt -= x;
    c.amt -= x;
    if (d.amt <= 1) i++;
    if (c.amt <= 1) j++;
  }
  return pays;
}

function Pill({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
      {children}
    </span>
  );
}

function Card({ title, children, right }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{title}</div>
        </div>
        {right}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function AuthPanel() {
  const [tab, setTab] = useState("signin");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      if (tab === "signup") {
        await createUserWithEmailAndPassword(auth, email.trim(), pw);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), pw);
      }
    } catch (e) {
      setErr(e?.message || "Authentication error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white border shadow-sm p-6">
        <div className="text-xl font-semibold">Shared Expenses + Rent Split</div>
        <div className="text-sm text-slate-600 mt-1">
          Sign in (or sign up) to access the shared ledger.
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setTab("signin")}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm ${tab === "signin" ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            Sign in
          </button>
          <button
            onClick={() => setTab("signup")}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm ${tab === "signup" ? "bg-slate-900 text-white" : "bg-white"}`}
          >
            Sign up
          </button>
        </div>

        <div className="mt-4 grid gap-3">
          <div>
            <div className="text-xs font-medium text-slate-600">Email</div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="name@example.com"
            />
          </div>
          <div>
            <div className="text-xs font-medium text-slate-600">Password</div>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="••••••••"
            />
          </div>

          {err ? <div className="text-sm text-red-600">{err}</div> : null}

          <button
            onClick={submit}
            disabled={busy || !email || !pw}
            className="rounded-xl bg-slate-900 text-white px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Please wait…" : tab === "signup" ? "Create account" : "Sign in"}
          </button>

          <div className="text-xs text-slate-500 leading-relaxed">
            Tip: Create one account for each brother (3 emails). This app uses Firebase, so everyone sees the same live data.
          </div>
        </div>
      </div>
    </div>
  );
}

function SplitEditor({ value, onChange }) {
  const total = (value.b1 || 0) + (value.b2 || 0) + (value.b3 || 0);
  const ok = Math.abs(total - 1) < 0.0001;

  const set = (k, v) => {
    const num = Math.max(0, Math.min(1, Number(v)));
    onChange({ ...value, [k]: num });
  };

  const setEqual = () => onChange({ b1: 1 / 3, b2: 1 / 3, b3: 1 / 3 });

  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Split ratio</div>
        <button onClick={setEqual} className="text-xs underline">
          Set equal
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        {BROTHERS.map((b) => (
          <div key={b.id}>
            <div className="text-xs text-slate-600">{b.label}</div>
            <input
              type="number"
              step="0.01"
              value={value[b.id] ?? 0}
              onChange={(e) => set(b.id, e.target.value)}
              className="mt-1 w-full rounded-lg border px-2 py-1 text-sm"
            />
          </div>
        ))}
      </div>

      <div className={`mt-2 text-xs ${ok ? "text-slate-600" : "text-red-600"}`}>
        Total: {total.toFixed(2)} {ok ? "(OK)" : "(must equal 1.00)"}
      </div>
    </div>
  );
}

function AppShell({ user }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");

  // Form state
  const [kind, setKind] = useState("expense_legal");
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState("b1");
  const [note, setNote] = useState("");
  const [shares, setShares] = useState({ b1: 1 / 3, b2: 1 / 3, b3: 1 / 3 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query(collection(db, "ledger"), orderBy("date", "desc"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      setItems(rows);
    });
    return () => unsub();
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((x) => x.kind === filter);
  }, [items, filter]);

  const balances = useMemo(() => computeLedger(items), [items]);
  const settlements = useMemo(() => suggestedSettlements(balances), [balances]);

  const add = async () => {
    setBusy(true);
    try {
      const amt = Number(amount);
      if (!amt || amt <= 0) throw new Error("Enter a valid amount");
      const shareTotal = (shares.b1 || 0) + (shares.b2 || 0) + (shares.b3 || 0);
      if (Math.abs(shareTotal - 1) > 0.0001) throw new Error("Split ratio must total 1.00");

      await addDoc(collection(db, "ledger"), {
        kind,
        date,
        amount: amt,
        payer,
        note,
        shares,
        createdAt: serverTimestamp(),
        createdBy: user?.uid || null,
      });

      setAmount("");
      setNote("");
      setKind("expense_legal");
      setShares({ b1: 1 / 3, b2: 1 / 3, b3: 1 / 3 });
    } catch (e) {
      alert(e?.message || "Could not add entry");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!confirm("Delete this entry?")) return;
    await deleteDoc(doc(db, "ledger", id));
  };

  const togglePaid = async (id, value) => {
    await updateDoc(doc(db, "ledger", id), { markedPaid: !value });
  };

  const kindLabel = (k) => TYPE_OPTIONS.find((x) => x.value === k)?.label || k;
  const brotherLabel = (id) => BROTHERS.find((b) => b.id === id)?.label || id;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Shared Expense and Rent Split</div>
            <div className="text-xs text-slate-600">3-member ledger · real-time</div>
          </div>
          <div className="flex items-center gap-2">
            <Pill>{user?.email}</Pill>
            <button
              onClick={() => signOut(auth)}
              className="rounded-xl border px-3 py-1.5 text-sm"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 grid gap-4">
          <Card title="Add entry">
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs font-medium text-slate-600">Type</div>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-600">Date</div>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs font-medium text-slate-600">
                    {kind === "income_rent" ? "Amount received" : "Amount paid"}
                  </div>
                  <input
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                    placeholder="e.g., 25000"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-600">
                    {kind === "income_rent" ? "Received by" : "Paid by"}
                  </div>
                  <select
                    value={payer}
                    onChange={(e) => setPayer(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    {BROTHERS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600">Note</div>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g., Advocate invoice Jan 2026 / Rent Feb 2026"
                />
              </div>

              <SplitEditor value={shares} onChange={setShares} />

              <button
                onClick={add}
                disabled={busy}
                className="rounded-xl bg-slate-900 text-white px-3 py-2 text-sm disabled:opacity-50"
              >
                {busy ? "Saving…" : "Add to ledger"}
              </button>

              <div className="text-xs text-slate-500">
                Tip: Use split ratio for uneven ownership (e.g., 0.50/0.25/0.25) or set equal for 1/3 each.
              </div>
            </div>
          </Card>

          <Card
            title="Balances (who is owed / who owes)"
            right={<Pill>Live</Pill>}
          >
            <div className="grid gap-2">
              {BROTHERS.map((b) => {
                const v = balances[b.id] || 0;
                const label = v >= 0 ? "Owed" : "Owes";
                return (
                  <div key={b.id} className="flex items-center justify-between gap-3">
                    <div className="text-sm">{b.label}</div>
                    <div className={`text-sm font-semibold ${v >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {label} {currency(Math.abs(v))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 border-t pt-3">
              <div className="text-xs font-medium text-slate-600">Suggested settlements</div>
              {settlements.length === 0 ? (
                <div className="text-sm text-slate-600 mt-1">All settled.</div>
              ) : (
                <div className="mt-2 grid gap-2">
                  {settlements.map((s, idx) => (
                    <div key={idx} className="text-sm">
                      <span className="font-medium">{brotherLabel(s.from)}</span> pays{" "}
                      <span className="font-medium">{brotherLabel(s.to)}</span> {currency(s.amount)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="lg:col-span-2 grid gap-4">
          <Card
            title="Ledger"
            right={
              <div className="flex items-center gap-2">
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="rounded-xl border px-3 py-1.5 text-sm"
                >
                  <option value="all">All</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-600">
                  <tr className="border-b">
                    <th className="py-2 text-left">Date</th>
                    <th className="py-2 text-left">Type</th>
                    <th className="py-2 text-left">Paid/Received by</th>
                    <th className="py-2 text-right">Amount</th>
                    <th className="py-2 text-left">Split</th>
                    <th className="py-2 text-left">Note</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <tr key={it.id} className="border-b align-top">
                      <td className="py-2 whitespace-nowrap">{it.date}</td>
                      <td className="py-2 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Pill>{kindLabel(it.kind)}</Pill>
                          {it.markedPaid ? <Pill>Paid</Pill> : <Pill>Open</Pill>}
                        </div>
                      </td>
                      <td className="py-2 whitespace-nowrap">{brotherLabel(it.payer)}</td>
                      <td className="py-2 text-right font-semibold whitespace-nowrap">{currency(it.amount)}</td>
                      <td className="py-2 whitespace-nowrap text-xs text-slate-700">
                        {BROTHERS.map((b) => (
                          <div key={b.id}>
                            {b.label}: {((it.shares?.[b.id] ?? 0) * 100).toFixed(0)}%
                          </div>
                        ))}
                      </td>
                      <td className="py-2 min-w-[220px]">{it.note}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => togglePaid(it.id, it.markedPaid)}
                            className="rounded-lg border px-2 py-1 text-xs"
                          >
                            {it.markedPaid ? "Mark open" : "Mark paid"}
                          </button>
                          <button
                            onClick={() => remove(it.id)}
                            className="rounded-lg border px-2 py-1 text-xs"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 ? (
                <div className="text-sm text-slate-600 mt-3">No entries yet.</div>
              ) : null}
            </div>
          </Card>

          <Card title="How to deploy (quick)">
            <ol className="list-decimal pl-5 text-sm text-slate-700 grid gap-1">
              <li>
                Create a new React app (Vite or CRA), paste this file as <code>App.jsx</code>.
              </li>
              <li>
                <code>npm i firebase</code>
              </li>
              <li>
                Replace <code>FIREBASE_CONFIG</code> with your Firebase web config.
              </li>
              <li>
                Deploy on Vercel/Netlify. Share the URL with your brothers.
              </li>
              <li>
                In Firebase Auth, create 3 user accounts (one per brother).
              </li>
            </ol>
            <div className="text-xs text-slate-500 mt-2">
              If you want, I can also tighten Firestore security rules so only your 3 emails can access this ledger.
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}

export default function SharedLedgerApp() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
    return () => unsub();
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-600">Loading…</div>
      </div>
    );
  }

  if (!user) return <AuthPanel />;
  return <AppShell user={user} />;
}


"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    setSubmitting(false);
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.href = next;
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Login failed.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="w-full max-w-xs flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-center">Food Shop</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          className="w-full px-4 py-3 rounded-full bg-gray-900 border border-gray-800 text-gray-100 outline-none focus:border-gray-600"
        />
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full py-3 rounded-full bg-gray-100 text-gray-900 font-semibold disabled:opacity-40"
        >
          {submitting ? "Checking…" : "Enter"}
        </button>
        {error && <p className="text-sm text-red-400 text-center">{error}</p>}
      </form>
    </div>
  );
}

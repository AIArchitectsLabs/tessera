import { invoke } from "@tauri-apps/api/core";
import type { SpawnResult } from "@tessera/contracts";
import { useState } from "react";

export default function App() {
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ping() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await invoke<SpawnResult>("sidecar_ping");
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>Tessera</h1>
      <p>Agent Workspace — Phase 1 Sandbox</p>

      <button type="button" onClick={ping} disabled={loading}>
        {loading ? "Pinging..." : "Ping CLI"}
      </button>

      {error && <pre style={{ color: "red", marginTop: "1rem" }}>Error: {error}</pre>}

      {result && (
        <pre style={{ marginTop: "1rem", background: "#111", color: "#0f0", padding: "1rem" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </main>
  );
}

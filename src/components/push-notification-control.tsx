"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";

interface PushNotificationControlProps {
  session: WorkspaceSession;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

export function PushNotificationControl({ session }: PushNotificationControlProps) {
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const available = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!available) return;
    navigator.serviceWorker.ready
      .then(async (registration) => {
        const current = await registration.pushManager.getSubscription();
        setSubscription(current);
        setSupported(true);
      })
      .catch(() => undefined);
  }, []);

  async function toggle() {
    setBusy(true);
    setMessage("");
    try {
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
          body: JSON.stringify({ endpoint }),
        });
        setSubscription(null);
        setMessage("Browser alerts are off.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Browser notification permission was not granted");
      const configResponse = await fetch("/api/push/config", { credentials: "same-origin", cache: "no-store" });
      const config = await configResponse.json() as { publicKey?: string };
      if (!configResponse.ok || !config.publicKey) throw new Error("Web Push is not configured on this Orbit server");
      const registration = await navigator.serviceWorker.ready;
      const next = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey),
      });
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify(next.toJSON()),
      });
      if (!response.ok) throw new Error("The browser subscription could not be saved");
      setSubscription(next);
      setMessage("Browser alerts are on.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Browser alerts could not be changed");
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  return (
    <div className="push-control">
      <button type="button" disabled={busy} onClick={toggle}>
        {busy ? "Updating…" : subscription ? "Browser alerts on" : "Enable browser alerts"}
      </button>
      {message && <small role="status">{message}</small>}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, useId } from "react";
import { WebRTCManager } from "@/lib/webrtc";
import { sendFile, FileReceiver, TransferProgress, FileHeader } from "@/lib/transfer";
import { wakeLockManager } from "@/lib/wakelock";

interface DiscoveredPeer {
  id: string;
  name: string;
}

export default function GlacierApp() {
  const [localPeerId, setLocalPeerId] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>("");

  const [nearbyPeers, setNearbyPeers] = useState<DiscoveredPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("Scanning Wi-Fi...");

  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [transferRole, setTransferRole] = useState<'glacier' | 'sea' | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const rtcRef = useRef<WebRTCManager | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const wakeLockRef = useRef<wakeLockManager>(new wakeLockManager());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let id = sessionStorage.getItem("glacier_peer_id");
    let name = sessionStorage.getItem("glacier_device_name");

    if (!id || !name) {
      id = "peer_" + Math.random().toString(36).substring(2, 9);
      const platform =
        typeof navigator !== "undefined" && /iPhone|iPad|Android/i.test(navigator.userAgent)
          ? "Mobile Fjord"
          : "Desktop Glacier";
      name = `${platform} (${Math.floor(100 + Math.random() * 900)})`;

      sessionStorage.setItem("glacier_peer_id", id);
      sessionStorage.setItem("glacier_device_name", name);
    }

    setLocalPeerId(id);
    setDeviceName(name);

    const handleUnload = () => {
      if (id) {
        navigator.sendBeacon("/api/peers", JSON.stringify({ id, action: "leave" }));
      }
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);


  useEffect(() => {
    if (!localPeerId) return;

    const rtc = new WebRTCManager(localPeerId, {
      onConnectionStateChange: (state) => {
        setConnectionStatus(state === 'connected' ? 'Current Flowing (Connected)' : state);
      },
      onMessageReceived: async (data) => {
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'header') {
              setTransferRole('sea');
              setIsTransferring(true);
              setCurrentFileName(parsed.name);
              wakeLockRef.current.request();

              const receiver = new FileReceiver(
                (p) => setProgress(p),
                (url) => {
                  setIsTransferring(false);
                  wakeLockRef.current.release();
                  if (url) setDownloadUrl(url);
                }
              );
              receiverRef.current = receiver;
              await receiver.prepareDisk(parsed as FileHeader);
            }
            else if (parsed.type === 'complete') {
              await receiverRef.current?.finish();
            }
          }
          catch (e) {
            console.error("Control message error: ", e);
          }
        }
        else if (data instanceof ArrayBuffer) {
          await receiverRef.current?.writeChunk(data);
        }
      }
    });

    rtcRef.current = rtc;

    const heartbeatTimer = setInterval(async () => {
      try {
        const res = await fetch("/api/peers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: localPeerId, name: deviceName }),
        });
        const data = await res.json();
        if (data.peers) setNearbyPeers(data.peers);
      } catch (err) {
        console.error("Heartbeat error:", err);
      }
    }, 4000);

    const signalTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/signal?peerId=${localPeerId}`);
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          for (const msg of data.messages) {
            if (msg.type === "offer") {
              await rtc.handleOffer(msg.senderId, msg.data);
            } else if (msg.type === "answer") {
              await rtc.handleAnswer(msg.data);
            } else if (msg.type === "candidate") {
              await rtc.handleCandidate(msg.data);
            }
          }
        }
      } catch (err) {
        console.error("Signal poll error:", err);
      }
    }, 1500);

    return () => {
      clearInterval(heartbeatTimer);
      clearInterval(signalTimer);
      rtc.close();
      fetch("/api/peers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: localPeerId }),
      }).catch(() => { });
    };

  }, [localPeerId, deviceName]);

  const handleFileSelected = async (file: File) => {
    if (!selectedPeer || !rtcRef.current) return;

    setTransferRole('glacier');
    setIsTransferring(true);
    setCurrentFileName(file.name);
    await wakeLockRef.current.request();

    try {
      let channel = rtcRef.current.getDataChannel();
      if (!channel || channel.readyState !== 'open') {
        await rtcRef.current.createOffer(selectedPeer.id);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Connection time out")), 10000);

          const check = setInterval(() => {
            const ch = rtcRef.current?.getDataChannel();
            if (ch && ch.readyState === 'open') {
              clearInterval(check);
              clearTimeout(timeout);
              resolve();
            }
          }, 300);
        });
        channel = rtcRef.current.getDataChannel();
      }

      if (channel) {
        await sendFile(file, channel, (p) => setProgress(p));
      }

    } catch (err) {
      console.error("Transfer failed:", err);
      alert("Tranfer interrputed or timed out.");
    }
    finally {
      setIsTransferring(false);
      wakeLockRef.current.release();
    }
  };
  return (
    <main className="min-h-screen bg-[#030712] text-white flex flex-col items-center p-6 relative overflow-hidden font-sans">
      {/* ─── Background / OGL Container Hook ─────────────────────────── */}
      <div id="glacier-bg" className="absolute inset-0 pointer-events-none opacity-40">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-cyan-600/20 rounded-full blur-[120px]" />
      </div>
      {/* ─── Header Bar ─────────────────────────────────────────────── */}
      <header className="w-full max-w-2xl flex items-center justify-between py-4 border-b border-cyan-900/40 relative z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">🧊</span>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-cyan-50">GLACIER</h1>
            <p className="text-xs text-cyan-400/80">Local Wi-Fi P2P Drift</p>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-cyan-950/40 border border-cyan-800/40 px-3 py-1.5 rounded-full text-xs text-cyan-300">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span>{deviceName || "Initializing..."}</span>
        </div>
      </header>
      {/* ─── Main Content ───────────────────────────────────────────── */}
      <div className="w-full max-w-2xl flex-1 flex flex-col justify-center gap-8 py-10 relative z-10">

        {/* Radar: Discovered Peers */}
        <section className="bg-slate-900/60 backdrop-blur-xl border border-cyan-900/40 rounded-3xl p-6 flex flex-col items-center gap-4 text-center">
          <div className="text-xs font-mono tracking-widest uppercase text-cyan-400/70">
            Same Wi-Fi Fjord Radar
          </div>
          {nearbyPeers.length === 0 ? (
            <div className="py-8 flex flex-col items-center gap-2 text-slate-400">
              <div className="w-12 h-12 rounded-full border border-dashed border-cyan-800/60 flex items-center justify-center animate-spin">
                🌊
              </div>
              <p className="text-sm">Scanning for other devices on your Wi-Fi...</p>
              <p className="text-xs text-slate-500">Open Glacier on your phone or laptop to connect.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mt-2">
              {nearbyPeers.map((peer) => (
                <button
                  key={peer.id}
                  onClick={() => {
                    setSelectedPeer(peer);
                    fileInputRef.current?.click();
                  }}
                  className={`p-4 rounded-2xl border text-left flex items-center gap-3.5 transition cursor-pointer ${selectedPeer?.id === peer.id
                    ? "bg-cyan-950/60 border-cyan-400 text-cyan-50"
                    : "bg-slate-950/40 border-cyan-900/40 hover:border-cyan-700 text-slate-200"
                    }`}
                >
                  <div className="w-10 h-10 rounded-xl bg-cyan-900/40 border border-cyan-800/60 flex items-center justify-center text-lg">
                    📱
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{peer.name}</p>
                    <p className="text-xs text-cyan-400/70">Tap to calve & send</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
        {/* Hidden File Picker */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelected(file);
          }}
        />
        {/* Active Transfer / Glacial Drift Card */}
        {isTransferring && (
          <section className="bg-cyan-950/40 backdrop-blur-xl border border-cyan-500/30 rounded-3xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-cyan-400 animate-spin">❄️</span>
                <span className="text-sm font-semibold text-cyan-100">
                  {transferRole === "glacier" ? "Calving Iceberg to Sea" : "Receiving in Fjord"}
                </span>
              </div>
              <span className="text-xs font-mono text-cyan-400 bg-cyan-900/50 px-2 py-0.5 rounded-md">
                Permafrost Active (Screen Awake)
              </span>
            </div>
            <div className="text-xs text-slate-300 font-mono truncate">
              {currentFileName}
            </div>
            {/* Ice Progress Bar */}
            <div className="w-full bg-slate-950/80 rounded-full h-3 overflow-hidden border border-cyan-900/60">
              <div
                className="bg-gradient-to-r from-cyan-500 to-teal-400 h-full transition-all duration-300"
                style={{ width: `${progress?.percentage || 0}%` }}
              />
            </div>
            {/* Live Telemetry */}
            <div className="flex items-center justify-between text-xs font-mono text-cyan-300/80">
              <span>{progress?.percentage || 0}% Complete</span>
              <span>{progress?.speedMBs || 0} MB/s</span>
            </div>
          </section>
        )}
        {/* Mobile Download Ready Card */}
        {downloadUrl && (
          <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-2xl p-4 flex items-center justify-between">
            <span className="text-xs text-emerald-200">Iceberg safely anchored in device storage!</span>
            <a
              href={downloadUrl}
              download={currentFileName}
              className="text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black px-3 py-1.5 rounded-lg transition"
            >
              Save to Files
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
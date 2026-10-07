"use client";

import { useState, useEffect, useRef } from "react";
import { WebRTCManager } from "@/lib/webrtc";
import { sendFile, FileReceiver, TransferProgress, FileHeader } from "@/lib/transfer";
import { wakeLockManager } from "@/lib/wakelock";

interface DiscoveredPeer {
  id: string;
  name: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatETA(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (["mp4", "mkv", "mov", "avi"].includes(ext || "")) return "🎬";
  if (["mp3", "wav", "flac", "m4a"].includes(ext || "")) return "🎵";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext || "")) return "📦";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext || "")) return "🖼️";
  if (["pdf", "docx", "txt", "md"].includes(ext || "")) return "📄";
  return "🧊";
}

export default function GlacierApp() {
  const [localPeerId, setLocalPeerId] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>("");

  const [nearbyPeers, setNearbyPeers] = useState<DiscoveredPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);

  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [transferRole, setTransferRole] = useState<"glacier" | "sea" | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string>("");
  const [currentFileSize, setCurrentFileSize] = useState<number>(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);

  const rtcRef = useRef<WebRTCManager | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const wakeLockRef = useRef<wakeLockManager>(new wakeLockManager());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let id = sessionStorage.getItem("glacier_peer_id");
    let name = sessionStorage.getItem("glacier_device_name");

    if (!id || !name) {
      id = "peer_" + Math.random().toString(36).substring(2, 9);
      const isMobile = typeof navigator !== "undefined" && /iPhone|iPad|Android/i.test(navigator.userAgent);
      const platform = isMobile ? "Mobile Fjord" : "Desktop Glacier";
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
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  useEffect(() => {
    if (!localPeerId) return;

    const rtc = new WebRTCManager(localPeerId, {
      onMessageReceived: async (data) => {
        if (typeof data === "string") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "header") {
              setTransferRole("sea");
              setIsTransferring(true);
              setIsCompleted(false);
              setDownloadUrl(null);
              setCurrentFileName(parsed.name);
              setCurrentFileSize(parsed.size);
              wakeLockRef.current.request();

              const receiver = new FileReceiver(
                (p) => setProgress(p),
                (url) => {
                  setIsTransferring(false);
                  setIsCompleted(true);
                  wakeLockRef.current.release();
                  if (url) setDownloadUrl(url);
                }
              );
              receiverRef.current = receiver;
              await receiver.prepareDisk(parsed as FileHeader);
            } else if (parsed.type === "complete") {
              await receiverRef.current?.finish();
            }
          } catch (e) {
            console.error("Control message error:", e);
          }
        } else if (data instanceof ArrayBuffer) {
          await receiverRef.current?.writeChunk(data);
        }
      },
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
    }, 3500);

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
    }, 1200);

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

    setTransferRole("glacier");
    setIsTransferring(true);
    setIsCompleted(false);
    setDownloadUrl(null);
    setCurrentFileName(file.name);
    setCurrentFileSize(file.size);
    await wakeLockRef.current.request();

    try {
      let channel = rtcRef.current.getDataChannel();
      if (!channel || channel.readyState !== "open") {
        await rtcRef.current.createOffer(selectedPeer.id);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Connection timed out")), 12000);
          const check = setInterval(() => {
            const ch = rtcRef.current?.getDataChannel();
            if (ch && ch.readyState === "open") {
              clearInterval(check);
              clearTimeout(timeout);
              resolve();
            }
          }, 250);
        });
        channel = rtcRef.current.getDataChannel();
      }

      if (channel) {
        await sendFile(file, channel, (p) => setProgress(p));
        setIsCompleted(true);
      }
    } catch (err) {
      console.error("Transfer failed:", err);
      alert("Transfer was interrupted.");
    } finally {
      setIsTransferring(false);
      wakeLockRef.current.release();
    }
  };

  const handleMobileSave = async () => {
    if (!downloadUrl) return;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        const response = await fetch(downloadUrl);
        const blob = await response.blob();
        const file = new File([blob], currentFileName, { type: blob.type });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: currentFileName,
          });
          return;
        }
      } catch (err) {
        console.warn("Native share dismissed or unsupported, falling back to download link", err);
      }
    }

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = currentFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Calculate live ETA
  const remainingBytes = currentFileSize - (progress?.bytesTransferred || 0);
  const etaSeconds = progress?.speedMBs && progress.speedMBs > 0
    ? remainingBytes / (progress.speedMBs * 1024 * 1024)
    : 0;

  return (
    <main className="min-h-screen bg-[#030712] text-slate-100 flex flex-col items-center justify-between p-4 sm:p-6 relative overflow-hidden font-sans select-none">

      <div id="glacier-bg" className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/6 left-1/2 -translate-x-1/2 w-80 sm:w-96 h-80 sm:h-96 bg-cyan-600/15 rounded-full blur-[140px]" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 bg-teal-600/10 rounded-full blur-[120px]" />
      </div>

      <header className="w-full max-w-lg flex items-center justify-between py-3 border-b border-cyan-900/30 relative z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl drop-shadow-[0_0_12px_rgba(56,189,248,0.5)]">🧊</span>
          <div>
            <h1 className="text-base font-bold tracking-wider text-cyan-50">GLACIER</h1>
            <p className="text-[10px] text-cyan-400/80 font-mono">Same Wi-Fi P2P Drift</p>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-slate-900/80 border border-cyan-800/40 px-3 py-1.5 rounded-full text-xs text-cyan-300 backdrop-blur-md shadow-inner">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="max-w-[140px] truncate font-medium">{deviceName || "Locating..."}</span>
        </div>
      </header>

      <div className="w-full max-w-lg flex-1 flex flex-col justify-center gap-6 py-6 relative z-10">

        {/* Radar Card */}
        <section className="bg-slate-900/60 backdrop-blur-2xl border border-cyan-900/40 rounded-3xl p-5 sm:p-6 shadow-2xl flex flex-col items-center gap-4 text-center">
          <div className="flex items-center justify-between w-full text-[11px] font-mono tracking-widest text-cyan-400/70 border-b border-cyan-950/80 pb-3">
            <span>NEARBY SEAS & FJORDS</span>
            <span className="text-cyan-500 font-semibold">{nearbyPeers.length} Found</span>
          </div>

          {nearbyPeers.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-3 text-slate-400">
              <div className="relative w-14 h-14 rounded-full border border-dashed border-cyan-700/60 flex items-center justify-center animate-spin">
                <span className="text-xl">🌊</span>
              </div>
              <p className="text-sm font-medium text-slate-300">Listening on your Wi-Fi router...</p>
              <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                Open Glacier on your phone or PC on the same Wi-Fi to calve and drift files instantly.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 w-full mt-1">
              {nearbyPeers.map((peer) => (
                <button
                  key={peer.id}
                  onClick={() => {
                    setSelectedPeer(peer);
                    fileInputRef.current?.click();
                  }}
                  className={`p-4 rounded-2xl border text-left flex items-center gap-3.5 transition active:scale-[0.98] cursor-pointer ${selectedPeer?.id === peer.id
                    ? "bg-cyan-950/70 border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.2)]"
                    : "bg-slate-950/50 border-cyan-900/30 hover:border-cyan-700 text-slate-200"
                    }`}
                >
                  <div className="w-11 h-11 rounded-xl bg-cyan-950/60 border border-cyan-800/60 flex items-center justify-center text-xl shrink-0">
                    {peer.name.includes("Mobile") ? "📱" : "💻"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-cyan-50">{peer.name}</p>
                    <p className="text-xs text-cyan-400/80">Tap to calve & send iceberg</p>
                  </div>
                  <span className="text-xs text-cyan-400 font-mono bg-cyan-950/80 border border-cyan-800/50 px-2.5 py-1 rounded-lg">
                    Send
                  </span>
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

        {/* Active Transfer Card (The Glacial Drift) */}
        {isTransferring && (
          <section className="bg-slate-900/80 backdrop-blur-2xl border border-cyan-500/40 rounded-3xl p-5 sm:p-6 shadow-[0_0_35px_rgba(6,182,212,0.15)] flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="animate-spin text-base">❄️</span>
                <span className="text-xs sm:text-sm font-bold text-cyan-100 uppercase tracking-wide">
                  {transferRole === "glacier" ? "Calving Iceberg to Sea" : "Receiving in Fjord"}
                </span>
              </div>
              <span className="text-[10px] font-mono text-cyan-300 bg-cyan-950/80 border border-cyan-700/60 px-2 py-0.5 rounded-full flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                Permafrost Active
              </span>
            </div>

            {/* File Info */}
            <div className="flex items-center gap-3 bg-slate-950/60 p-3 rounded-2xl border border-cyan-900/40">
              <span className="text-2xl">{getFileIcon(currentFileName)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs sm:text-sm font-semibold truncate text-cyan-50">{currentFileName}</p>
                <p className="text-[11px] font-mono text-cyan-400/70">
                  {formatBytes(progress?.bytesTransferred || 0)} / {formatBytes(currentFileSize)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-mono font-bold text-cyan-300">{progress?.percentage || 0}%</p>
                <p className="text-[10px] font-mono text-slate-400">{formatETA(etaSeconds)} left</p>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-950 rounded-full h-3.5 overflow-hidden p-0.5 border border-cyan-800/60 shadow-inner">
              <div
                className="bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 h-full rounded-full transition-all duration-200 shadow-[0_0_12px_rgba(45,212,191,0.7)]"
                style={{ width: `${progress?.percentage || 0}%` }}
              />
            </div>

            {/* Live Telemetry Meter */}
            <div className="flex items-center justify-between text-[11px] font-mono text-cyan-300/80 pt-1">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                Flow Speed: <strong className="text-cyan-200">{progress?.speedMBs || 0} MB/s</strong>
              </span>
              <span>Encrypted Wi-Fi P2P</span>
            </div>
          </section>
        )}

        {/* Transfer Complete / Save Actions */}
        {isCompleted && (
          <section className="bg-emerald-950/40 backdrop-blur-xl border border-emerald-500/40 rounded-3xl p-5 shadow-2xl flex flex-col gap-3 animate-in fade-in duration-300">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 text-sm">
                ✓
              </div>
              <div className="flex-1">
                <p className="text-xs sm:text-sm font-bold text-emerald-100">Iceberg Anchored Successfully!</p>
                <p className="text-[11px] text-emerald-300/80 font-mono">
                  {currentFileName} ({formatBytes(currentFileSize)})
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-2">
              {downloadUrl ? (
                // Mobile Action: Opens iOS / Android Native Share Sheet
                <button
                  onClick={handleMobileSave}
                  className="w-full py-3 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs sm:text-sm transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99]"
                >
                  <span>📲</span>
                  <span>Save to Files / Share</span>
                </button>
              ) : (
                // Desktop Action: Confirmation notice
                <div className="p-2.5 bg-emerald-950/60 border border-emerald-600/30 rounded-xl text-center text-xs text-emerald-200 font-mono">
                  ✨ Safely written directly to your chosen hard drive folder
                </div>
              )}
            </div>
          </section>
        )}

      </div>

      <footer className="w-full max-w-lg py-2 flex items-center justify-between text-[10px] font-mono text-cyan-700 relative z-10 border-t border-cyan-950">
        <span>Glacier Engine • Zero Cloud Storage</span>
        <span>100% P2P LAN</span>
      </footer>

    </main>
  );
}

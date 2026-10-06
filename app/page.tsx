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
  const [nearbyPeers, setNearbyPeers] = useState<DiscoveredPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("Scanning Wi-Fi...");

  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [transferRole, setTransferRole] = useState<'glacier' | 'sea' | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);



}
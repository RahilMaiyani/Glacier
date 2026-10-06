const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ],
};

export type ConnectionState = "idle" | 'connecting' | 'connected' | 'disconnected' | "failed";

export interface WebRTCManagerCallbacks {
    onConnectionStateChange?: (state: ConnectionState) => void;
    onDataChannelReady?: (channel: RTCDataChannel) => void;
    onMessageReceived?: (data: ArrayBuffer | string) => void;
}

export class WebRTCManager {
    private pc: RTCPeerConnection | null = null;
    private dataChannel: RTCDataChannel | null = null;
    private localPeerId: string;
    private remotePeerId: string | null = null;
    private callbacks: WebRTCManagerCallbacks;

    constructor(localPeerId: string, callbacks: WebRTCManagerCallbacks = {}) {
        this.localPeerId = localPeerId;
        this.callbacks = callbacks;
    }

    private initPeerConnection(remotePeerId: string): RTCPeerConnection {
        this.remotePeerId = remotePeerId;
        const pc = new RTCPeerConnection(RTC_CONFIG);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal("candidate", event.candidate);
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState as ConnectionState;
            this.callbacks.onConnectionStateChange?.(state);
        };

        pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };
        this.pc = pc;
        return pc;
    }

    private setupDataChannel(channel: RTCDataChannel) {
        this.dataChannel = channel;
        this.dataChannel.binaryType = "arraybuffer";

        this.dataChannel.onopen = () => {
            this.callbacks.onConnectionStateChange?.("connected");
            this.callbacks.onDataChannelReady?.(this.dataChannel!);
        }

        this.dataChannel.onmessage = (event) => {
            this.callbacks.onMessageReceived?.(event.data);
        }

        this.dataChannel.onclose = () => {
            this.callbacks.onConnectionStateChange?.("disconnected");
        };
    }

    public async createOffer(remotePeerId: string): Promise<void> {
        const pc = this.initPeerConnection(remotePeerId);

        const channel = pc.createDataChannel("file-transfer", {
            ordered: true,
        });
        this.setupDataChannel(channel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await this.sendSignal("offer", offer);
    }

    public async handleOffer(remotePeerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
        const pc = this.initPeerConnection(remotePeerId);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal("answer", answer);
    }

    public async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        if (this.pc) {
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }

    public async handleCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (this.pc) {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    private async sendSignal(type: "offer" | "answer" | "candidate", data: any) {
        if (!this.remotePeerId) return;
        try {
            await fetch("/api/signal", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    senderId: this.localPeerId,
                    targetId: this.remotePeerId,
                    type,
                    data,
                }),
            });
        } catch (err) {
            console.error("Failed to send signal:", err);
        }
    }

    public getDataChannel(): RTCDataChannel | null {
        return this.dataChannel;
    }

    public close() {
        this.dataChannel?.close();
        this.pc?.close();
        this.dataChannel = null;
        this.pc = null;
        this.remotePeerId = null;
    }

}
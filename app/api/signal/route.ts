import { NextResponse, NextRequest } from "next/server";

export interface SignalMessage {
    senderId: string;
    targetId: string;
    type: "offer" | "answer" | "candidate";
    data: any;
    timestamp: number;
}

const signalMailBox = new Map<string, SignalMessage[]>();

function cleanupOldSignals() {
    const cutoff = Date.now() - 30_000;
    for (const [targetId, messages] of signalMailBox.entries()) {
        const valid = messages.filter((m) => m.timestamp > cutoff);
        if (valid.length === 0) {
            signalMailBox.delete(targetId);
        }
        else {
            signalMailBox.set(targetId, valid);
        }
    }
}

export async function POST(req: NextRequest) {
    try {
        const { senderId, targetId, type, data } = await req.json();

        if (!senderId || !targetId || !type || !data) {
            return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
        }

        cleanupOldSignals();

        const existing = signalMailBox.get(targetId) || [];
        existing.push({
            senderId,
            targetId,
            type,
            data,
            timestamp: Date.now(),
        });
        signalMailBox.set(targetId, existing);

        return NextResponse.json({ ok: true });
    }
    catch {
        return NextResponse.json({ error: "Invalid Request" }, { status: 400 });
    }
}

export async function GET(req: NextRequest) {
    try {
        const peerId = req.nextUrl.searchParams.get("peerId");

        if (!peerId) {
            return NextResponse.json({ error: "peerId query param is required." }, { status: 400 });
        }

        cleanupOldSignals();

        const messages = signalMailBox.get(peerId) || [];
        signalMailBox.delete(peerId);

        return NextResponse.json({ messages });
    }
    catch {
        return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
}
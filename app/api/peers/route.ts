import { NextResponse, NextRequest } from "next/server";

interface Peer {
    id: string;
    name: string;
    ip: string;
    lastSeen: number;
}

const activePeers = new Map<string, Peer>();

function cleanupStalePeers() {
    const now = Date.now();
    for (const [id, peer] of activePeers.entries()) {
        if (now - peer.lastSeen > 15_000) {
            activePeers.delete(id);
        }
    }
}

function getClientIp(req: NextRequest): string {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
        return forwarded.split(",")[0].trim();
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp) {
        return realIp.trim();
    }

    return "127.0.0.1";
}

export async function POST(req: NextRequest) {
    try {
        const { id, name } = await req.json();

        if (!id || !name) {
            return NextResponse.json({ error: "Missing id or name" }, { status: 400 });
        }

        const ip = getClientIp(req);
        cleanupStalePeers();

        activePeers.set(id, {
            id,
            name,
            ip,
            lastSeen: Date.now(),
        });

        const peersOnSameNetwork = Array.from(activePeers.values())
            .filter((peer) => peer.ip === ip && peer.id !== id)
            .map(({ id, name }) => ({ id, name }));

        return NextResponse.json({ peers: peersOnSameNetwork });
    }
    catch {
        return NextResponse.json({ error: "Invalid Request" }, { status: 400 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const { id } = await req.json();
        if (id) {
            activePeers.delete(id);
        }
        return NextResponse.json({ ok: true });
    }
    catch {
        return NextResponse.json({ error: "Invalid Request" }, { status: 400 });
    }
}
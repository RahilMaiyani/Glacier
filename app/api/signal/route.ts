import { NextResponse, NextRequest } from "next/server";
import { Redis } from "@upstash/redis";

const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = hasRedis ? Redis.fromEnv() : null;

export interface SignalMessage {
    senderId: string;
    targetId: string;
    type: "offer" | "answer" | "candidate";
    data: any;
    timestamp: number;
}
const localMailBox = new Map<string, SignalMessage[]>();

export async function POST(req: NextRequest) {
    try {
        const { senderId, targetId, type, data } = await req.json();

        if (!senderId || !targetId || !type || !data) {
            return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
        }

        const message: SignalMessage = {
            senderId,
            targetId,
            type,
            data,
            timestamp: Date.now(),
        };

        if (redis) {
            await redis.rpush(`signal:${targetId}`, JSON.stringify(message));
            await redis.expire(`signal:${targetId}`, 30);
        }
        else {
            const existing = localMailBox.get(targetId) || [];
            existing.push({
                senderId,
                targetId,
                type,
                data,
                timestamp: Date.now(),
            });
            localMailBox.set(targetId, existing);

        }

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

        let messages: SignalMessage[] = [];

        if (redis) {
            const raw = await redis.lrange<string | SignalMessage>(`signal:${peerId}`, 0, -1);
            await redis.del(`signal:${peerId}`);
            messages = (raw || []).map((m) => (typeof m === "string" ? JSON.parse(m) : m));
        } else {
            messages = localMailBox.get(peerId) || [];
            localMailBox.delete(peerId);
        }

        return NextResponse.json({ messages });
    } catch {
        return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
}

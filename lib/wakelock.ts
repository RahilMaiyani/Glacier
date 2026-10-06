export class wakeLockManager {
    private sentinel: WakeLockSentinel | null = null;

    public async request(): Promise<boolean> {
        if (typeof window === 'undefined' || !('wakeLock' in navigator)) {
            return false;
        }

        try {
            this.sentinel = await navigator.wakeLock.request("screen");
            this.sentinel.addEventListener("release", () => {
                this.sentinel = null;
            });
            return true;
        }
        catch (err) {
            console.warn("Screen Wake Lock failed:", err);
            return false;
        }
    }

    public release(): void {
        if (this.sentinel) {
            this.sentinel.release().catch(() => { });
            this.sentinel = null;
        }
    }

    public isActive(): boolean {
        return this.sentinel !== null;
    }
}
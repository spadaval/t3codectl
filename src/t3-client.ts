/** T3 orchestration protocol 2: authenticated snapshots and Effect JSON RPC. */
export class T3Client {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private baseUrl: string, private token: string) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid T3 base URL");
    this.baseUrl = url.origin;
  }

  async get(path: string): Promise<any> {
    return this.request(path);
  }

  private async request(path: string, post = false): Promise<any> {
    const response = await fetch(this.baseUrl + path, {
      method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "x-t3-orchestration-protocol": "2" },
      ...(post ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    // Never include credential-bearing URLs or server response bodies in errors.
    if (!response.ok) throw new Error(`T3 ${path} returned HTTP ${response.status}`);
    return response.json();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  private async connect(): Promise<void> {
    const { ticket } = await this.request("/api/auth/websocket-ticket", true);
    if (typeof ticket !== "string" || !ticket) throw new Error("invalid T3 WebSocket ticket");
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("orchestrationProtocol", "2");
    url.searchParams.set("wsTicket", ticket);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message._tag === "Ping") { socket.send(JSON.stringify({ _tag: "Pong" })); return; }
        if (message._tag !== "Exit") return;
        const id = String(message.requestId);
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        if (message.exit?._tag === "Success") request.resolve(message.exit.value);
        else request.reject(new Error("T3 rejected the orchestration command"));
      } catch { this.rejectPending(new Error("invalid T3 RPC response")); }
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("T3 WebSocket connection timed out")); }, 15000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("T3 WebSocket connection failed")); this.rejectPending(new Error("T3 WebSocket failed")); };
      socket.onclose = () => { clearTimeout(timer); reject(new Error("T3 WebSocket closed")); this.rejectPending(new Error("T3 WebSocket closed")); };
    });
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) await this.connect();
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("T3 command timed out; delivery may have succeeded")); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ _tag: "Request", id, tag: "orchestration.dispatchCommand", payload: command, headers: [] })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("T3 command send failed")); }
    });
  }

  close(): void {
    this.rejectPending(new Error("T3 client closed"));
    this.socket?.close();
    this.socket = undefined;
  }
}

import WebSocket from 'ws';
import type { CdpClient, PageSession } from './types.ts';

// Caps every reply wait so a frozen Chrome cannot wedge an awaiter (notably the reaper).
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const ATTACH_TIMEOUT_MS = 10_000;

// Chrome honours browser-wide commands regardless of sessionId: acked here, never forwarded.
const BLOCKED_PAGE_ACK = new Map<string, Record<string, unknown>>([
  ['Browser.close', {}],
  ['Browser.crash', {}],
  ['Browser.crashGpuProcess', {}],
  ['Target.closeTarget', { success: false }],
]);
// Refused with a CDP error: tab/context lifecycle belongs to the REST API or browser_ws.
const BLOCKED_PAGE_ERROR = new Set([
  'Target.createTarget',
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
]);

/** Connect to a Chrome DevTools websocket. `connectTimeoutMs` caps the upgrade wait (the
 * remote-debugging consent dialog can hold it open); `sendTimeoutMs` caps every reply. */
export function connectCdp(
  wsUrl: string,
  opts?: { connectTimeoutMs?: number; sendTimeoutMs?: number },
): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    // CDP frames can be huge (screenshots); never forward a browser Origin (ws sends none).
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    let nextId = 1;
    let opened = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.connectTimeoutMs) {
      connectTimer = setTimeout(() => {
        if (opened) return;
        reject(new Error(`CDP websocket did not open within ${opts.connectTimeoutMs}ms`));
        ws.terminate();
      }, opts.connectTimeoutMs);
    }
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const eventHandlers = new Map<string, ((params: any) => void)[]>();
    const closeHandlers: (() => void)[] = [];
    const sendTimeoutMs = opts?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

    // sessionRoutes: every sessionId (root + children) → owning session.
    // sessionCmdOwners: upstream command id → { session, clientId } for reply remap.
    const sessionRoutes = new Map<string, PageSessionImpl>();
    const sessionCmdOwners = new Map<
      number,
      { session: PageSessionImpl; clientId: number; timer: ReturnType<typeof setTimeout> }
    >();
    const liveSessions = new Set<PageSessionImpl>();

    function sendRaw(frame: Record<string, unknown>): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }

    class PageSessionImpl implements PageSession {
      root: string;
      owned: Set<string>;
      messageCb: (text: string) => void = () => {};
      closeCb: (code: number, reason: string) => void = () => {};
      closed = false;

      constructor(root: string) {
        this.root = root;
        this.owned = new Set([root]);
      }

      onMessage(cb: (text: string) => void): void {
        this.messageCb = cb;
      }
      onClose(cb: (code: number, reason: string) => void): void {
        this.closeCb = cb;
      }

      fromClient(text: string): void {
        if (this.closed) return;
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          return; // never forward non-JSON onto the shared connection
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

        if (typeof msg.method === 'string') {
          const ack = BLOCKED_PAGE_ACK.get(msg.method);
          if (ack) {
            if (typeof msg.id === 'number') this.messageCb(JSON.stringify({ id: msg.id, result: ack }));
            return;
          }
          if (BLOCKED_PAGE_ERROR.has(msg.method)) {
            if (typeof msg.id === 'number') {
              this.messageCb(
                JSON.stringify({
                  id: msg.id,
                  error: { code: -32601, message: `${msg.method} is not permitted on a page session` },
                }),
              );
            }
            return;
          }
        }

        // Omitted/null/"" pins to root; a non-empty sessionId must be a child this session
        // owns, or it could address another client's session on the shared connection.
        if (typeof msg.sessionId !== 'string' || msg.sessionId === '') {
          msg.sessionId = this.root;
        } else if (!this.owned.has(msg.sessionId)) {
          if (typeof msg.id === 'number') {
            this.messageCb(
              JSON.stringify({ id: msg.id, error: { code: -32001, message: 'Session not found.' } }),
            );
          }
          return;
        }

        if (typeof msg.id === 'number') {
          const up = nextId++;
          // Reclaim the routing slot: Chrome may never answer once the target detached.
          const timer = setTimeout(() => sessionCmdOwners.delete(up), sendTimeoutMs);
          timer.unref?.();
          sessionCmdOwners.set(up, { session: this, clientId: msg.id, timer });
          msg.id = up;
        }
        sendRaw(msg);
      }

      // Restore the client's id; strip the root sessionId (child replies keep theirs).
      deliverReply(msg: any, clientId: number): void {
        if (this.closed) return;
        msg.id = clientId;
        if (msg.sessionId === this.root) delete msg.sessionId;
        this.messageCb(JSON.stringify(msg));
      }

      // Session-scoped event (arrived tagged with one of our sessionIds).
      deliverEvent(msg: any): void {
        if (this.closed) return;
        if (msg.method === 'Target.attachedToTarget') {
          const child = msg.params?.sessionInfo?.sessionId;
          if (typeof child === 'string') {
            this.owned.add(child);
            sessionRoutes.set(child, this);
          }
        } else if (msg.method === 'Target.detachedFromTarget') {
          const gone = msg.params?.sessionId;
          if (typeof gone === 'string' && gone !== this.root) {
            this.owned.delete(gone);
            sessionRoutes.delete(gone);
          }
        }
        if (msg.sessionId === this.root) delete msg.sessionId;
        this.messageCb(JSON.stringify(msg));
      }

      // Root target died (browser-level detach naming our root): mirror a page ws dying.
      rootGone(): void {
        this.end(1001, 'target closed', true);
      }

      end(code: number, reason: string, notify: boolean): void {
        if (this.closed) return;
        this.closed = true;
        liveSessions.delete(this);
        for (const s of this.owned) sessionRoutes.delete(s);
        for (const [id, owner] of sessionCmdOwners) {
          if (owner.session === this) {
            clearTimeout(owner.timer);
            sessionCmdOwners.delete(id);
          }
        }
        if (notify) this.closeCb(code, reason);
      }

      detach(): void {
        if (this.closed) return;
        // Best-effort; a plain untracked id (reply, if any, is ignored by the loop).
        sendRaw({ id: nextId++, method: 'Target.detachFromTarget', params: { sessionId: this.root } });
        this.end(1000, '', false);
      }
    }

    const client: CdpClient = {
      send(method, params) {
        return new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) {
            rej(new Error(`CDP socket not open (${method})`));
            return;
          }
          const id = nextId++;
          const timer = setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`CDP command timed out after ${sendTimeoutMs}ms (${method})`));
          }, sendTimeoutMs);
          timer.unref?.();
          pending.set(id, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify(params ? { id, method, params } : { id, method }));
        });
      },
      on(event, handler) {
        const list = eventHandlers.get(event);
        if (list) list.push(handler);
        else eventHandlers.set(event, [handler]);
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
      async attachPageSession(targetId) {
        const result = (await Promise.race([
          client.send('Target.attachToTarget', { targetId, flatten: true }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`attach to target ${targetId} timed out`)), ATTACH_TIMEOUT_MS),
          ),
        ])) as { sessionId?: string };
        if (typeof result?.sessionId !== 'string') {
          throw new Error(`attach to target ${targetId} returned no sessionId`);
        }
        const session = new PageSessionImpl(result.sessionId);
        sessionRoutes.set(session.root, session);
        liveSessions.add(session);
        return session;
      },
      close() {
        ws.close();
      },
    };

    ws.on('open', () => {
      opened = true;
      clearTimeout(connectTimer);
      resolve(client);
    });
    ws.on('error', (err: Error) => {
      if (!opened) reject(err);
    });
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? 'CDP error')));
          else p.resolve(msg.result);
          return;
        }
        const owner = sessionCmdOwners.get(msg.id);
        if (owner) {
          sessionCmdOwners.delete(msg.id);
          clearTimeout(owner.timer);
          owner.session.deliverReply(msg, owner.clientId);
        }
        return;
      }
      if (typeof msg.method !== 'string') return;
      if (typeof msg.sessionId === 'string') {
        const s = sessionRoutes.get(msg.sessionId);
        if (s) s.deliverEvent(msg);
        return;
      }
      // Browser-level (no sessionId). A root target's death arrives here naming the dead
      // session in params: route it to the owner before the manager's handlers run.
      if (msg.method === 'Target.detachedFromTarget' && typeof msg.params?.sessionId === 'string') {
        const s = sessionRoutes.get(msg.params.sessionId);
        if (s) s.rootGone();
      }
      const list = eventHandlers.get(msg.method);
      if (list) for (const h of [...list]) h(msg.params);
    });
    ws.on('close', () => {
      const err = new Error('CDP socket closed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      for (const s of [...liveSessions]) s.end(1011, 'shared browser connection closed', true);
      for (const h of closeHandlers.splice(0)) h();
    });
  });
}

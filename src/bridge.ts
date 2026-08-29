import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { ChromeInstance } from './types.ts';

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
  try {
    if (code === 1005 || code === 1006) ws.close();
    else ws.close(code, reason.slice(0, 120));
  } catch {
    ws.terminate();
  }
}

/** Bridges one page-level client onto an adopted browser's single approved connection. */
export function bridgePageConnection(
  client: WebSocket,
  instance: ChromeInstance,
  targetId: string,
  log: (msg: string) => void = () => {},
): void {
  const buffered: string[] = [];
  let session: import('./types.ts').PageSession | null = null;
  let clientClosed = false;

  instance.cdp
    .attachPageSession(targetId)
    .then((s) => {
      if (clientClosed) {
        s.detach();
        return;
      }
      session = s;
      s.onMessage((text) => {
        if (client.readyState === WebSocket.OPEN) client.send(text);
      });
      s.onClose((code, reason) => {
        safeClose(client, code, reason);
      });
      for (const text of buffered.splice(0)) s.fromClient(text);
    })
    .catch((err) => {
      log(`bridge ${instance.id}/${targetId}: ${err.message ?? err}`);
      safeClose(client, 1011, `attach to target failed: ${err.message ?? err}`);
    });

  client.on('message', (data, isBinary) => {
    if (isBinary) return; // CDP is JSON text; drop binary client frames
    const text = rawToString(data);
    if (session) session.fromClient(text);
    else buffered.push(text);
  });

  client.on('close', () => {
    clientClosed = true;
    if (session) session.detach();
  });

  client.on('error', () => {
    clientClosed = true;
    if (session) session.detach();
    client.terminate();
  });
}

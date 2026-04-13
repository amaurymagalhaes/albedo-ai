import type { BrowserRPC } from "../hooks/useRPC";

const handlers: Map<string, Function[]> = new Map();

const mockRpc: BrowserRPC = {
  addMessageListener(event: string, handler: Function): void {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
  },
  removeMessageListener(event: string, handler: Function): void {
    const arr = handlers.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
    }
  },
  send(event: string, payload: unknown): void {
    console.log(`[mock rpc → main] ${event}`, payload);
  },
  sendProxy: new Proxy({} as Record<string, (payload: any) => void>, {
    get(_, prop: string) {
      return (payload: any) =>
        console.log(`[mock rpc → main] ${prop}`, payload);
    },
  }),
  request: {},
};

export function simulateEvent(event: string, payload: unknown): void {
  handlers.get(event)?.forEach((h) => h(payload));
}

export { mockRpc };

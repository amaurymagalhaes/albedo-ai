import { useEffect, useCallback, useRef } from "react";
import type {
  MainToViewEvents,
  ViewToMainEvents,
} from "../types/rpc";

type EventHandler<K extends keyof MainToViewEvents> = (
  payload: MainToViewEvents[K]
) => void;

type AnyHandler = (payload: any) => void;

export interface BrowserRPC {
  addMessageListener(name: string, handler: AnyHandler): void;
  removeMessageListener(name: string, handler: AnyHandler): void;
  send(name: string, payload: any): void;
  sendProxy: Record<string, (payload: any) => void>;
  request: Record<string, (params?: any) => Promise<any>>;
}

declare global {
  interface Window {
    __albedoRpc?: BrowserRPC;
  }
}

function getRpc(): BrowserRPC | undefined {
  return window.__albedoRpc;
}

export function initRpc(rpc: BrowserRPC): void {
  window.__albedoRpc = rpc;
}

export function useRPC() {
  const on = useCallback(
    <K extends keyof MainToViewEvents>(
      event: K,
      handler: EventHandler<K>
    ): (() => void) => {
      const rpc = getRpc();
      const wrapped = handler as AnyHandler;
      if (rpc?.addMessageListener) {
        rpc.addMessageListener(event as string, wrapped);
        return () => {
          rpc.removeMessageListener(event as string, wrapped);
        };
      }
      console.warn(`[rpc] addMessageListener not available for "${String(event)}"`);
      return () => {};
    },
    []
  );

  const emit = useCallback(
    <K extends keyof ViewToMainEvents>(
      event: K,
      payload: ViewToMainEvents[K]
    ): void => {
      const rpc = getRpc();
      if (rpc?.sendProxy && (rpc.sendProxy as any)[event as string]) {
        (rpc.sendProxy as any)[event as string](payload);
      } else if (rpc?.send) {
        rpc.send(event as string, payload);
      } else {
        console.warn(`[rpc] cannot emit "${String(event)}", no transport`);
      }
    },
    []
  );

  return { on, emit };
}

export function useRPCEvent<K extends keyof MainToViewEvents>(
  event: K,
  handler: EventHandler<K>
): void {
  const { on } = useRPC();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = on(event, (payload) => handlerRef.current(payload));
    return unsubscribe;
  }, [event, on]);
}

import { useEffect, useCallback, useRef } from "react";

type AnyHandler = (payload: any) => void;

export interface SettingsBrowserRPC {
  addMessageListener(name: string, handler: AnyHandler): void;
  removeMessageListener(name: string, handler: AnyHandler): void;
  send(name: string, payload: any): void;
  sendProxy: Record<string, (payload: any) => void>;
  request: Record<string, (params?: any) => Promise<any>>;
}

declare global {
  interface Window {
    __settingsRpc?: SettingsBrowserRPC;
  }
}

function getRpc(): SettingsBrowserRPC | undefined {
  return window.__settingsRpc;
}

export function initRpc(rpc: SettingsBrowserRPC): void {
  window.__settingsRpc = rpc;
}

export function useSettingsRPC() {
  const on = useCallback(
    (event: string, handler: AnyHandler): (() => void) => {
      const rpc = getRpc();
      if (rpc?.addMessageListener) {
        rpc.addMessageListener(event, handler);
        return () => {
          rpc.removeMessageListener(event, handler);
        };
      }
      console.warn(`[settings-rpc] addMessageListener not available for "${event}"`);
      return () => {};
    },
    []
  );

  const emit = useCallback(
    (event: string, payload: any): void => {
      const rpc = getRpc();
      if (rpc?.sendProxy && (rpc.sendProxy as any)[event]) {
        (rpc.sendProxy as any)[event](payload);
      } else if (rpc?.send) {
        rpc.send(event, payload);
      } else {
        console.warn(`[settings-rpc] cannot emit "${event}", no transport`);
      }
    },
    []
  );

  return { on, emit };
}

export function useSettingsRPCEvent(
  event: string,
  handler: AnyHandler
): void {
  const { on } = useSettingsRPC();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = on(event, (payload) => handlerRef.current(payload));
    return unsubscribe;
  }, [event, on]);
}

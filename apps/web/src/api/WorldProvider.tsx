import { createContext, useContext, type ReactNode } from 'react';
import { useWorld, type UseWorldOptions, type UseWorldResult } from './useWorld';

const WorldContext = createContext<UseWorldResult | null>(null);

/**
 * 把 useWorld() 的單一輪詢實例提升到 context——MapShell / PanelLayout / TreatyPage
 * 過去各自呼叫 useWorld() 會各自起一條 45s 輪詢、各自累積 events(finding #7)。
 * 整個 App 只掛一個 WorldProvider(見 App.tsx),下面所有頁面共用同一份 world/events。
 */
export function WorldProvider({ children, options }: { children: ReactNode; options?: UseWorldOptions }) {
  const world = useWorld(options);
  return <WorldContext.Provider value={world}>{children}</WorldContext.Provider>;
}

export function useWorldContext(): UseWorldResult {
  const ctx = useContext(WorldContext);
  if (!ctx) throw new Error('useWorldContext() 必須在 <WorldProvider> 底下使用');
  return ctx;
}

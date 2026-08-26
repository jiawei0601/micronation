import { createContext, useContext, type ReactNode } from 'react';
import { useWorld, type UseWorldOptions, type UseWorldResult } from './useWorld';

const WorldContext = createContext<UseWorldResult | null>(null);

/**
 * 把 useWorld() 的單一輪詢實例提升到 context——MapShell / PanelLayout / TreatyPage
 * 過去各自呼叫 useWorld() 會各自起一條 45s 輪詢、各自累積 events(finding #7)。
 * 整個 App 只掛一個 WorldProvider(見 App.tsx),下面所有頁面共用同一份 world/events。
 *
 * 跨帳號事件外洩修復:呼叫端(LoginPage 登入成功、PanelLayout 登出、FoundingPage 建國成功)
 * 透過 useWorldContext().resetWorld() 主動清空 events/游標,避免沿用前一個身分累積的事件。
 * useWorld 另外支援 options.identityKey(身分 key 變化時自動 reset)——此處不預設帶入
 * useNation() 的結果,因為 WorldProvider 掛在 Router 外層、比任何頁面都早掛載,若在此耦合
 * 一份額外的 useNation() 輪詢,會在每次 nation 狀態轉換(loading→ready/unauthenticated)時
 * 都重置一次世界視圖,干擾既有頁面對「輪詢節奏穩定」的假設;因此 identityKey 自動偵測留給
 * 未來若真的需要時,由呼叫端在建立 WorldProvider 的地方自行傳入,不在此處預設啟用。
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

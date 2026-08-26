import type { ReactNode } from 'react';

/** B 風深色面板共用的 KPI 卡/卡片/進度條/列表元件(對齊 prototype 變體 B)。 */

export function Kpi({ label, value, delta }: { label: string; value: string; delta?: string }) {
  const isUp = delta?.startsWith('+');
  const isDown = delta?.startsWith('−') || delta?.startsWith('-');
  return (
    <div className="rounded-xl border border-[#232a38] bg-chart-panel p-3">
      <div className="text-xs text-[#9aa4b5]">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      {delta ? (
        <div className={`mt-0.5 text-xs ${isUp ? 'text-[#3fb950]' : isDown ? 'text-[#e5534b]' : 'text-[#9aa4b5]'}`}>{delta}</div>
      ) : null}
    </div>
  );
}

export function Card({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#232a38] bg-chart-panel p-4">
      <h3 className="mb-2 flex items-center justify-between text-sm text-[#c7cede]">
        <span>{title}</span>
        {extra}
      </h3>
      {children}
    </div>
  );
}

export function Bar({ percent, color = '#4c8dff' }: { percent: number; color?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="my-2 h-2 overflow-hidden rounded bg-[#232a38]">
      <div className="h-full" style={{ width: `${clamped}%`, backgroundColor: color }} />
    </div>
  );
}

export function PanelRow({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex justify-between border-b border-[#1d2430] py-1.5 text-sm last:border-0">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

export function Tag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'war' }) {
  const cls =
    tone === 'war'
      ? 'bg-[#2b1d1d] text-[#ff8f88]'
      : tone === 'ok'
        ? 'bg-[#1b2a1e] text-[#7ee787]'
        : 'bg-[#1d2635] text-[#8ab4ff]';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

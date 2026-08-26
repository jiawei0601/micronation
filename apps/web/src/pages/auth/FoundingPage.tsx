import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FlagSpec } from '@micronation/shared';
import { Flag } from '../../components/flag/Flag';
import { DEFAULT_EMBLEM, DEFAULT_LAYOUT, DEFAULT_PALETTE, EMBLEMS, LAYOUTS, PALETTES } from '../../components/flag/flagOptions';
import { useWorldContext } from '../../api/WorldProvider';
import { foundFn } from '../../api/founding';
import { t } from '../../i18n/zh-Hant';

/** 國名上限——對齊 apps/api/src/game/constants.ts isNameAllowed(trim 後 1~20 字)。 */
const NATION_NAME_MAX = 20;

/** 開國流程:國名+旗幟產生器(即時預覽輸出 FlagSpec)+選區。區域清單改吃 /api/world 回應裡的
 *  regions(mock 與真 API 同介面),不再寫死;送出時帶 regionId 而非 index。 */
export function FoundingPage() {
  const navigate = useNavigate();
  const { world, resetWorld } = useWorldContext();
  const regions = world?.regions ?? [];

  const [nationName, setNationName] = useState('');
  const [layoutId, setLayoutId] = useState(DEFAULT_LAYOUT);
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE);
  const [emblemId, setEmblemId] = useState(DEFAULT_EMBLEM);
  const [regionId, setRegionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const palette = PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0];
  const flagSpec: FlagSpec = useMemo(
    () => ({ layout: layoutId, colors: palette.colors, emblem: emblemId }),
    [layoutId, palette, emblemId]
  );

  const trimmedName = nationName.trim().slice(0, NATION_NAME_MAX);
  const effectiveRegionId = regionId ?? regions[0]?.id ?? null;

  async function handleFound(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedName || !effectiveRegionId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await foundFn.found({ name: trimmedName, flag: flagSpec, regionId: effectiveRegionId });
      // 跨帳號事件外洩修復:建國成功即清空舊 world/events/游標,避免沿用建國前(可能是
      // 另一個身分)累積的事件——即時保險,不等 identityKey 自動偵測。
      resetWorld();
      navigate('/');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-chart-bg px-6 py-8 text-[#dce8f2]">
      <h1 className="mb-6 text-xl tracking-wide">{t.founding.title}</h1>
      <form onSubmit={handleFound} className="grid grid-cols-[1fr_320px] gap-8">
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm text-chart-accent">{t.founding.step1}</h2>
            <input
              value={nationName}
              onChange={(e) => setNationName(e.target.value)}
              placeholder={t.founding.nationNamePlaceholder}
              required
              maxLength={NATION_NAME_MAX}
              autoComplete="off"
              className="w-full max-w-sm rounded border border-chart-border bg-transparent px-3 py-2"
            />
            <div className="mt-1 text-right text-xs text-[#7fa3bd]">
              {trimmedName.length}/{NATION_NAME_MAX}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm text-chart-accent">{t.founding.step2}</h2>
            <div className="mb-3">
              <div className="mb-1 text-xs text-[#9fb8cc]">{t.founding.flagLayout}</div>
              <div className="flex flex-wrap gap-2">
                {LAYOUTS.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    onClick={() => setLayoutId(l.id)}
                    className={`rounded border px-2 py-1 text-xs ${layoutId === l.id ? 'border-chart-accent text-chart-accent' : 'border-chart-border'}`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-3">
              <div className="mb-1 text-xs text-[#9fb8cc]">{t.founding.flagPalette}</div>
              <div className="flex flex-wrap gap-2">
                {PALETTES.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => setPaletteId(p.id)}
                    title={p.label}
                    className={`flex h-7 w-7 overflow-hidden rounded border ${paletteId === p.id ? 'border-chart-accent' : 'border-chart-border'}`}
                  >
                    {p.colors.slice(0, 3).map((c, i) => (
                      <span key={i} style={{ backgroundColor: c }} className="h-full flex-1" />
                    ))}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-[#9fb8cc]">{t.founding.flagEmblem}</div>
              <div className="grid max-h-40 grid-cols-8 gap-2 overflow-y-auto">
                {EMBLEMS.map((em) => (
                  <button
                    type="button"
                    key={em.id}
                    title={em.label}
                    onClick={() => setEmblemId(em.id)}
                    className={`flex h-8 items-center justify-center rounded border text-[10px] ${emblemId === em.id ? 'border-chart-accent text-chart-accent' : 'border-chart-border'}`}
                  >
                    <svg viewBox="0 0 90 60" className="h-5 w-7">
                      <path d={em.path()} fill="currentColor" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm text-chart-accent">{t.founding.step3}</h2>
            {regions.length === 0 ? (
              <p className="text-sm text-[#7fa3bd]">{t.common.loading}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {regions.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    onClick={() => setRegionId(r.id)}
                    className={`rounded border px-3 py-1.5 text-sm ${effectiveRegionId === r.id ? 'border-chart-accent text-chart-accent' : 'border-chart-border'}`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </section>

          <button
            type="submit"
            disabled={submitting || !trimmedName || !effectiveRegionId}
            className="rounded bg-chart-blue px-6 py-2 text-sm disabled:opacity-50"
          >
            {t.founding.found}
          </button>
          {submitError ? <p className="text-xs text-[#ff8f88]">{submitError}</p> : null}
        </div>

        <aside className="sticky top-8 h-fit rounded-xl border border-chart-border bg-[rgba(13,32,46,0.82)] p-4">
          <Flag spec={flagSpec} className="w-full rounded shadow" title={trimmedName || t.founding.nationNamePlaceholder} />
          <p className="mt-3 text-center text-sm">{trimmedName || '—'}</p>
          <pre className="mt-3 overflow-x-auto rounded bg-black/30 p-2 text-[10px] text-[#9fb8cc]">
            {JSON.stringify(flagSpec, null, 2)}
          </pre>
        </aside>
      </form>
    </div>
  );
}

export default FoundingPage;

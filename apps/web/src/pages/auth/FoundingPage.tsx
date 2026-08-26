import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FlagSpec } from '@micronation/shared';
import { Flag } from '../../components/flag/Flag';
import { DEFAULT_EMBLEM, DEFAULT_LAYOUT, DEFAULT_PALETTE, EMBLEMS, LAYOUTS, PALETTES } from '../../components/flag/flagOptions';
import { t } from '../../i18n/zh-Hant';

const REGIONS = ['北境高地', '中原平野', '東方群島', '西漠礦區', '南方沃土', '遠洋列嶼'];

/** 開國流程:國名+旗幟產生器(即時預覽輸出 FlagSpec)+選區。 */
export function FoundingPage() {
  const navigate = useNavigate();
  const [nationName, setNationName] = useState('');
  const [layoutId, setLayoutId] = useState(DEFAULT_LAYOUT);
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE);
  const [emblemId, setEmblemId] = useState(DEFAULT_EMBLEM);
  const [regionIndex, setRegionIndex] = useState(0);

  const palette = PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0];
  const flagSpec: FlagSpec = useMemo(
    () => ({ layout: layoutId, colors: palette.colors, emblem: emblemId }),
    [layoutId, palette, emblemId]
  );

  function handleFound(e: React.FormEvent) {
    e.preventDefault();
    // API 尚未實作:開國後直接進入地圖主殼。
    navigate('/');
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
              className="w-full max-w-sm rounded border border-chart-border bg-transparent px-3 py-2"
            />
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
            <div className="flex flex-wrap gap-2">
              {REGIONS.map((r, i) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setRegionIndex(i)}
                  className={`rounded border px-3 py-1.5 text-sm ${regionIndex === i ? 'border-chart-accent text-chart-accent' : 'border-chart-border'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </section>

          <button type="submit" className="rounded bg-chart-blue px-6 py-2 text-sm">
            {t.founding.found}
          </button>
        </div>

        <aside className="sticky top-8 h-fit rounded-xl border border-chart-border bg-[rgba(13,32,46,0.82)] p-4">
          <Flag spec={flagSpec} className="w-full rounded shadow" title={nationName || t.founding.nationNamePlaceholder} />
          <p className="mt-3 text-center text-sm">{nationName || '—'}</p>
          <pre className="mt-3 overflow-x-auto rounded bg-black/30 p-2 text-[10px] text-[#9fb8cc]">
            {JSON.stringify(flagSpec, null, 2)}
          </pre>
        </aside>
      </form>
    </div>
  );
}

export default FoundingPage;

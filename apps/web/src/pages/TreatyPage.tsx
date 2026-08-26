import { Link, useParams } from 'react-router-dom';
import { Flag } from '../components/flag/Flag';
import { useWorld } from '../api/useWorld';
import { formatTicksAsDuration } from '../lib/format';
import { t } from '../i18n/zh-Hant';

/** A 風公文擬物頁——條約簽署版面。紙張底+印章+雙方國旗。 */
export function TreatyPage() {
  const { id } = useParams<{ id: string }>();
  const { world } = useWorld();
  const treaty = world?.treaties.find((tr) => tr.id === id) ?? null;
  const partyA = world?.nations.find((n) => n.id === treaty?.aId) ?? null;
  const partyB = world?.nations.find((n) => n.id === treaty?.bId) ?? null;

  return (
    <div className="min-h-screen bg-[#e8e2d4] px-6 py-8 font-serif text-[#2b2318]">
      <div className="mx-auto max-w-3xl border border-[#c9bfa5] bg-[#f7f3e8] p-10 shadow-lg">
        <div className="flex items-center gap-4 border-b-[3px] border-double border-[#8a7a55] pb-4">
          <div>
            <h1 className="text-2xl tracking-[6px]">{t.treaty.title}</h1>
            <div className="mt-1 text-xs tracking-[2px] text-[#7a6c4e]">
              {treaty ? t.diplomacy.kinds[treaty.kind] : '—'} · {t.common.tick} {world?.tick ?? '—'}
            </div>
          </div>
          <div className="ml-auto flex h-16 w-16 -rotate-12 items-center justify-center rounded-full border-[3px] border-[#a33] text-center text-[11px] text-[#a33] opacity-80">
            外交部印
          </div>
        </div>

        {!treaty ? (
          <p className="mt-8 text-sm text-[#7a6c4e]">找不到條約 {id}</p>
        ) : (
          <>
            <div className="mt-8 grid grid-cols-2 gap-6">
              <PartyBlock label={t.treaty.partyA} nation={partyA} signed={treaty.status === 'active'} />
              <PartyBlock label={t.treaty.partyB} nation={partyB} signed={treaty.status === 'active'} />
            </div>

            <h2 className="mt-8 border-l-4 border-[#8a7a55] pl-2 text-sm tracking-[3px]">條約條款</h2>
            <table className="mt-2 w-full border-collapse text-sm">
              <tbody>
                <tr>
                  <td className="border border-[#cfc5a8] bg-[#eee7d3] p-2">{t.treaty.duration}</td>
                  <td className="border border-[#cfc5a8] p-2">{formatTicksAsDuration(treaty.terms.duration)}</td>
                </tr>
                {treaty.terms.compensation !== undefined ? (
                  <tr>
                    <td className="border border-[#cfc5a8] bg-[#eee7d3] p-2">賠償</td>
                    <td className="border border-[#cfc5a8] p-2">{treaty.terms.compensation}</td>
                  </tr>
                ) : null}
                {treaty.terms.tariffDiscount !== undefined ? (
                  <tr>
                    <td className="border border-[#cfc5a8] bg-[#eee7d3] p-2">關稅減免</td>
                    <td className="border border-[#cfc5a8] p-2">{Math.round(treaty.terms.tariffDiscount * 100)}%</td>
                  </tr>
                ) : null}
                <tr>
                  <td className="border border-[#cfc5a8] bg-[#eee7d3] p-2">狀態</td>
                  <td className="border border-[#cfc5a8] p-2">{t.diplomacy.status[treaty.status]}</td>
                </tr>
              </tbody>
            </table>

            {treaty.status === 'proposed' ? (
              <div className="mt-6 flex gap-3 text-sm">
                <button className="rounded border border-[#8a7a55] px-4 py-2">{t.diplomacy.accept}</button>
                <button className="rounded border border-[#8a7a55] px-4 py-2">{t.diplomacy.counter}</button>
                <button className="rounded border border-[#a33] px-4 py-2 text-[#a33]">{t.diplomacy.reject}</button>
              </div>
            ) : null}
          </>
        )}

        <div className="mt-10 flex justify-between text-xs tracking-[2px] text-[#8a7a55]">
          <Link to="/diplomacy" className="underline decoration-dotted">
            {t.common.back}
          </Link>
          <span>國政院謹呈</span>
        </div>
      </div>
    </div>
  );
}

function PartyBlock({ label, nation, signed }: { label: string; nation: { name: string; flag: { layout: string; colors: string[]; emblem: string } } | null; signed: boolean }) {
  return (
    <div className="border border-dashed border-[#b5a87f] p-4">
      <div className="mb-2 text-xs tracking-[2px] text-[#7a6c4e]">{label}</div>
      <div className="flex items-center gap-3">
        {nation ? <Flag spec={nation.flag} className="h-8 w-12 border border-[#8a7a55]" title={nation.name} /> : null}
        <span>{nation?.name ?? '—'}</span>
      </div>
      <div className="mt-3 text-xs">{signed ? `✓ ${t.treaty.signed}` : t.treaty.pending}</div>
    </div>
  );
}

export default TreatyPage;

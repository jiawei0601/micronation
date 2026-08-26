import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t } from '../../i18n/zh-Hant';
import { authFn, authErrorMessage } from '../../api/auth';
import { useWorldContext } from '../../api/WorldProvider';

export function LoginPage() {
  const navigate = useNavigate();
  const { resetWorld } = useWorldContext();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await authFn.login(email, password);
      // 跨帳號事件外洩修復:登入成功即清空前一個身分殘留的 world/events/游標,
      // 不能等 identityKey 的自動偵測(晚一拍,且此時 nation 可能還沒 refetch)。
      resetWorld();
      navigate('/');
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-chart-bg text-[#dce8f2]">
      <form onSubmit={handleSubmit} className="w-80 rounded-xl border border-chart-border bg-[rgba(13,32,46,0.9)] p-6">
        <h1 className="mb-4 text-lg">{t.auth.loginTitle}</h1>
        <label className="mb-3 block text-sm">
          {t.auth.email}
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-chart-border bg-transparent px-2 py-1"
          />
        </label>
        <label className="mb-4 block text-sm">
          {t.auth.password}
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-chart-border bg-transparent px-2 py-1"
          />
        </label>
        {error ? <p className="mb-3 text-xs text-[#ff8f88]">{error}</p> : null}
        <button type="submit" disabled={submitting} className="w-full rounded bg-chart-blue py-2 text-sm disabled:opacity-50">
          {submitting ? t.common.loading : t.auth.loginSubmit}
        </button>
        <p className="mt-3 text-center text-xs text-[#7fa3bd]">
          {t.auth.noAccount}{' '}
          <Link to="/register" className="underline">
            {t.auth.goRegister}
          </Link>
        </p>
      </form>
    </div>
  );
}

export default LoginPage;

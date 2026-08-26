import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t } from '../../i18n/zh-Hant';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 後端登入路由尚未接上(apps/api/src/auth 尚未掛 HTTP route):目前直接導向地圖。
    setSubmitting(true);
    navigate('/');
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

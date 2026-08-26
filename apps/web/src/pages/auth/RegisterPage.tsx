import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t } from '../../i18n/zh-Hant';
import { authFn, authErrorMessage } from '../../api/auth';

export function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mailSendFailed, setMailSendFailed] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { mailSent } = await authFn.register(email, password);
      if (!mailSent) {
        // finding #4:寄信失敗不擋註冊——帳號已建立,留在本頁提示補寄,而不是直接導去建國流程。
        setMailSendFailed(true);
        setSubmitting(false);
        return;
      }
      navigate('/founding');
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setResending(true);
    setResendResult(null);
    try {
      const { mailSent } = await authFn.resend(email);
      setResendResult(mailSent ? t.auth.resendSuccess : t.auth.resendFailed);
    } catch {
      setResendResult(t.auth.resendFailed);
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-chart-bg text-[#dce8f2]">
      <form onSubmit={handleSubmit} className="w-80 rounded-xl border border-chart-border bg-[rgba(13,32,46,0.9)] p-6">
        <h1 className="mb-4 text-lg">{t.auth.registerTitle}</h1>
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
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-chart-border bg-transparent px-2 py-1"
          />
        </label>
        {error ? <p className="mb-3 text-xs text-[#ff8f88]">{error}</p> : null}
        {mailSendFailed ? (
          <div className="mb-3 rounded border border-[#ff8f88] px-2 py-2 text-xs text-[#ff8f88]">
            <p>{t.auth.mailSendFailed}</p>
            <button
              type="button"
              disabled={resending}
              onClick={handleResend}
              className="mt-2 rounded border border-[#ff8f88] px-2 py-1 text-xs disabled:opacity-50"
            >
              {resending ? t.common.loading : t.auth.resend}
            </button>
            {resendResult ? <p className="mt-2 text-[#dce8f2]">{resendResult}</p> : null}
          </div>
        ) : null}
        <button type="submit" disabled={submitting} className="w-full rounded bg-chart-blue py-2 text-sm disabled:opacity-50">
          {submitting ? t.common.loading : t.auth.registerSubmit}
        </button>
        <p className="mt-3 text-center text-xs text-[#7fa3bd]">
          {t.auth.haveAccount}{' '}
          <Link to="/login" className="underline">
            {t.auth.goLogin}
          </Link>
        </p>
      </form>
    </div>
  );
}

export default RegisterPage;

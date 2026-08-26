// 寄信本身留 stub(M6 範圍外)——只定義介面,dev 實作用 console 輸出供本地驗證流程可測。

export interface MailSender {
  sendVerificationEmail(to: string, token: string): Promise<void>;
}

/** finding #21:env.RESEND_API_KEY 存在時,index.ts 改用這個實作而非 ConsoleMailSender。
 * TODO:實際呼叫 Resend REST API(https://api.resend.com/emails)寄出驗證信——留待正式帳號
 * 到位、能實測寄信成功與否再補;目前的 send 只是把 fetch 呼叫的骨架寫好但不驗證回應內容,
 * 避免在沒有真實金鑰的情況下製造一個看似完整、實際上未驗證過的寄信路徑。 */
export class ResendMailSender implements MailSender {
  constructor(private readonly apiKey: string) {}

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    // TODO: 接上正式 Resend API 後補上寄信內容模板(驗證連結網域待部署後確定)、錯誤處理與重試。
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        subject: '微國家 — 驗證你的信箱',
        text: `驗證 token:${token}`,
      }),
    });
  }
}

export class ConsoleMailSender implements MailSender {
  // dev/test 用:最近一次寄出的驗證信(明文 token,DB 現在只存雜湊——finding #1/#13),
  // 供整合測試在無法真的收信的情況下取得 token。正式 mail 實作不會有這個欄位。
  lastTo: string | null = null;
  lastToken: string | null = null;

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.lastTo = to;
    this.lastToken = token;
    // eslint-disable-next-line no-console
    console.log(`[dev-mail] verification email to ${to}: token=${token}`);
  }
}

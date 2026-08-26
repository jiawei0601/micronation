// 寄信本身留 stub(M6 範圍外)——只定義介面,dev 實作用 console 輸出供本地驗證流程可測。

export interface MailSender {
  sendVerificationEmail(to: string, token: string): Promise<void>;
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

// 寄信本身留 stub(M6 範圍外)——只定義介面,dev 實作用 console 輸出供本地驗證流程可測。

export interface MailSender {
  sendVerificationEmail(to: string, token: string): Promise<void>;
}

export class ConsoleMailSender implements MailSender {
  async sendVerificationEmail(to: string, token: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[dev-mail] verification email to ${to}: token=${token}`);
  }
}

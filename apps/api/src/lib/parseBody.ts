// finding #9:所有路由的 JSON body 解析統一走這個 helper——安全 parse(壞 JSON/空 body 一律
// 回 null,不拋例外)+ 物件型別檢查(null/陣列/字串/數字等非「一般物件」一律回 null → 呼叫端
// 400 INVALID_BODY)。原本各路由各自 `.json<T>().catch(() => ({}) as never)`,body 若是陣列
// (例如 `[]`)或 `null`(合法 JSON)會直接矇混過型別檢查,底下欄位存取全部 undefined、不會被
// 擋在最前面。

// ①-16:選用的 validator 參數——呼叫端可傳入欄位型別檢查函式,通不過時同樣視為壞 body 回 null
// (400 INVALID_BODY),不需要每個路由各自再包一層「parse 完之後才驗證」的樣板碼。未帶
// validator 時行為與原本相同,不強制所有呼叫端一次遷移。
export async function parseJsonBody<T extends Record<string, unknown>>(
  req: { json(): Promise<unknown> },
  validator?: (body: T) => boolean
): Promise<T | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const typed = body as T;
  if (validator && !validator(typed)) return null;
  return typed;
}

/** ②-3/②-8/②-18:字串欄位「先確認 typeof 再 trim」的共用小工具——直接對不受信任的輸入呼叫
 * `.trim()` 前若沒先檢查型別,像 `{ email: 5 }` 這種請求會在 .trim() 這一行丟未預期的
 * TypeError(路由原本只用 `!body.email` 這種 falsy 檢查,對 truthy 的非字串值完全防不住)。 */
export function asTrimmedString(value: unknown, maxLen = 10_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  return trimmed;
}

/** 同上,但不 trim(密碼等不該改動前後空白的欄位)——只做 typeof 檢查。 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

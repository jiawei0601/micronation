// finding #9:所有路由的 JSON body 解析統一走這個 helper——安全 parse(壞 JSON/空 body 一律
// 回 null,不拋例外)+ 物件型別檢查(null/陣列/字串/數字等非「一般物件」一律回 null → 呼叫端
// 400 INVALID_BODY)。原本各路由各自 `.json<T>().catch(() => ({}) as never)`,body 若是陣列
// (例如 `[]`)或 `null`(合法 JSON)會直接矇混過型別檢查,底下欄位存取全部 undefined、不會被
// 擋在最前面。

export async function parseJsonBody<T extends Record<string, unknown>>(req: {
  json(): Promise<unknown>;
}): Promise<T | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as T;
}

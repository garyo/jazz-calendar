/** Response and auth helpers shared by the Worker's routes. */

export function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/** JSON that no cache keeps: API answers are per request. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/**
 * The body as text, or null once it passes `limit` bytes. Counts what
 * actually arrives, since Content-Length may be absent or wrong; a declared
 * length over the limit is refused without reading.
 */
export async function readCapped(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

export function methodNotAllowed(allow: string): Response {
  return textResponse(405, "Method not allowed", { allow });
}

/** Constant-time comparison: both sides are hashed to equal-length digests. */
async function tokensMatch(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((token) =>
      crypto.subtle.digest("SHA-256", encoder.encode(token)),
    ),
  );
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Whether the request carries `Bearer <expected>`; never when unset. */
export async function hasBearer(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  const match = request.headers.get("authorization")?.match(/^Bearer (.+)$/);
  if (!expected || !match) return false;
  return tokensMatch(match[1], expected);
}

export function unauthorized(realm: string): Response {
  return textResponse(401, "Unauthorized", {
    "www-authenticate": `Bearer realm="${realm}"`,
  });
}

/**
 * Reads a small JSON request body, refusing anything larger than `maxBytes`
 * before parsing it. Returns undefined for a missing, oversized, or invalid
 * body.
 */
export async function readSmallJson(
  request: Request,
  maxBytes = 2048,
): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return undefined;
  const text = await request.text();
  if (text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The shape of every row ID the board makes or seeds. */
export const ROW_ID = /^[A-Za-z0-9_-]{1,32}$/;

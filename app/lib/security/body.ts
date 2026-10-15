/**
 * A request body as text, read up to `maxBytes` and no further: a body that
 * says or turns out to be longer is cancelled as soon as it passes the
 * limit, and the answer is null. Nothing is buffered beyond the limit,
 * whether or not the request declared its length.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A small JSON body, such as a vote or a report, read up to `maxBytes`;
 * undefined when it is longer or not JSON.
 */
export async function readSmallJson(
  request: Request,
  maxBytes = 2048,
): Promise<unknown> {
  const text = await readBodyCapped(request, maxBytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A form body read up to `maxBytes`, or null when it is longer. Forms here
 * carry text only, such as a comment.
 */
export async function readSmallForm(request: Request, maxBytes: number): Promise<FormData | null> {
  const text = await readBodyCapped(request, maxBytes);
  if (text === null) return null;
  return new Response(text, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
}

/** The shape of every row ID the board makes or seeds. */
export const ROW_ID = /^[A-Za-z0-9_-]{1,32}$/;

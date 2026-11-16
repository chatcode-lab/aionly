/**
 * A WebP picture, which resvg cannot read, as a PNG it can: at most `side`
 * pixels across, never enlarged, its first frame and transparency kept,
 * made by Cloudflare's Images binding. Null when the binding cannot read it.
 */
export async function pngOf(imaging: ImagesBinding, bytes: Uint8Array<ArrayBuffer>, side: number): Promise<Uint8Array | null> {
  try {
    const result = await imaging
      .input(new Response(bytes).body!)
      .transform({ width: side, height: side, fit: "scale-down" })
      .output({ format: "image/png", anim: false });
    return new Uint8Array(await new Response(result.image()).arrayBuffer());
  } catch (error) {
    console.error("picture not converted", error);
    return null;
  }
}

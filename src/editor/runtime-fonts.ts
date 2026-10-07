export interface RuntimeFontResult {
  family: string;
  loaded: number;
  failed: number;
}
let pending: Promise<RuntimeFontResult> | undefined;
/** Load URLs served by the local runtime; CSS contains no build-time asset references. */
export function loadRuntimeFonts(): Promise<RuntimeFontResult> {
  return (pending ??= (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined')
      return { family: 'Vmotion UI Sans', loaded: 0, failed: 2 };
    const fonts = [
      ['/runtime/font.otf', '100 500'],
      ['/runtime/font-bold.otf', '600 900'],
    ];
    const results = await Promise.allSettled(
      fonts.map(async ([url, weight]) => {
        const font = await new FontFace('Vmotion UI Sans', `url(${url})`, {
          weight,
          display: 'swap',
        }).load();
        document.fonts.add(font);
      }),
    );
    const loaded = results.filter((result) => result.status === 'fulfilled').length;
    return { family: 'Vmotion UI Sans', loaded, failed: results.length - loaded };
  })());
}

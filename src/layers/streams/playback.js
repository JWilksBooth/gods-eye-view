/**
 * Bounded HLS playback for a direct stream URL, in the CCTV decoder's
 * footprint (src/layers/cctv/videoPlayback.js): the same buffer caps, the
 * same two fatal-error retries, muted autoplay, and a dispose that detaches
 * everything. Unlike the CCTV path there is no server lease: the URL is the
 * provider's own playlist, requested only once a person opens the stream.
 * @param {HTMLVideoElement} video
 * @param {string} url
 * @param {{loadHls?: () => Promise<{default: object}>, onFailure?: () => void}} [options]
 * @returns {{dispose: () => void, ready: Promise<void>}}
 */
export function attachHlsVideo(
  video,
  url,
  { loadHls = () => import('hls.js'), onFailure = () => {} } = {},
) {
  let disposed = false;
  let hls = null;
  let timer = null;
  let startup = null;
  let retries = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(startup);
    hls?.destroy();
    hls = null;
    video.removeEventListener('canplay', play);
    video.removeEventListener('error', fail);
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    onFailure();
  };
  const play = () => {
    if (disposed) return;
    clearTimeout(startup);
    video.play().catch(() => {});
  };
  video.muted = true;
  video.loop = false;
  video.addEventListener('canplay', play);
  video.addEventListener('error', fail);
  startup = setTimeout(fail, 30000);
  const ready = (async () => {
    try {
      const { default: Hls } = await loadHls();
      if (disposed) return;
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
        else fail();
        return;
      }
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 24,
        maxMaxBufferLength: 30,
        backBufferLength: 0,
        maxBufferSize: 16 * 1024 * 1024,
        liveSyncDurationCount: 3,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data?.fatal) return;
        if (++retries > 2) {
          fail();
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else hls.loadSource(url);
        }, 2000);
      });
      hls.attachMedia(video);
      hls.loadSource(url);
    } catch {
      fail();
    }
  })();
  return { dispose, ready };
}

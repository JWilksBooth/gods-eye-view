/**
 * Embed descriptors for live streams: pure, so the registry, the tool and
 * the drawer agree on what a stream needs and nothing here touches the DOM.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Whether a string is a YouTube video id. */
export function isYouTubeVideoId(value) {
  return YOUTUBE_ID.test(String(value ?? ''));
}

/**
 * The privacy-enhanced player address for a video id: muted autoplay (so
 * nothing ever starts with sound), inline on phones, no related videos.
 * @param {string} videoId
 * @param {{autoplay?: boolean}} [options]
 * @returns {string|null}
 */
export function youtubeEmbedUrl(videoId, { autoplay = true } = {}) {
  if (!isYouTubeVideoId(videoId)) return null;
  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    mute: '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}

/** The watch page a stream links out to. */
export function youtubeWatchUrl(videoId) {
  return isYouTubeVideoId(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
}

/** The poster YouTube serves for a video, no key needed. */
export function youtubePosterUrl(videoId) {
  return isYouTubeVideoId(videoId)
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : null;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a stream record's embed into one of the shapes the drawer
 * renders; null when it cannot be shown at all.
 * @param {object} stream A registry or discovery record.
 * @returns {{kind: 'youtube', videoId: string, url: string, poster: string, link: string}
 *   |{kind: 'hls', url: string, poster: string|null, link: string|null}
 *   |{kind: 'mjpeg', url: string, link: string|null}
 *   |{kind: 'link', url: string, poster: string|null}|null}
 */
export function streamEmbed(stream) {
  const embed = stream?.embed || {};
  const poster = httpsUrl(stream?.poster) || null;
  switch (embed.type) {
    case 'youtube': {
      const videoId = embed.videoId || stream?.videoId;
      if (!isYouTubeVideoId(videoId)) return null;
      return {
        kind: 'youtube',
        videoId,
        url: youtubeEmbedUrl(videoId),
        poster: poster || youtubePosterUrl(videoId),
        link: youtubeWatchUrl(videoId),
      };
    }
    case 'hls': {
      const url = httpsUrl(embed.url);
      return url
        ? { kind: 'hls', url, poster, link: httpsUrl(stream?.pageUrl) }
        : null;
    }
    case 'mjpeg': {
      const url = httpsUrl(embed.url);
      return url
        ? { kind: 'mjpeg', url, link: httpsUrl(stream?.pageUrl) }
        : null;
    }
    case 'link': {
      const url = httpsUrl(embed.url) || httpsUrl(stream?.pageUrl);
      return url ? { kind: 'link', url, poster } : null;
    }
    default:
      return null;
  }
}

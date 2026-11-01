import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

/** The deepest zoom tile.openstreetmap.org serves; deeper requests fail and count toward the tile-failure fallback. */
export const OSM_MAXIMUM_LEVEL = 19;

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
    maximumLevel: OSM_MAXIMUM_LEVEL,
  });
}

/**
 * ImageryLayer options for a render-quality preset's imagery settings.
 *
 * Both filters stay LINEAR on purpose: Cesium generates mipmaps and applies
 * anisotropic filtering to power-of-two tiles only when the layer asks for
 * plain LINEAR filters (`ImageryLayer._finalizeReprojectTexture`); naming a
 * mipmap filter explicitly skips mipmap generation and samples an incomplete
 * texture. `maximumAnisotropy` caps the glancing-angle filtering per preset;
 * Cesium clamps it to what the GPU supports.
 * @param {{maximumAnisotropy?: number}} [imagery]
 */
export function imageryLayerOptions({ maximumAnisotropy } = {}) {
  return {
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
    magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
    ...(Number.isFinite(maximumAnisotropy) && maximumAnisotropy >= 1
      ? { maximumAnisotropy }
      : {}),
  };
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  if (
    style === Cesium.IonWorldImageryStyle.AERIAL ||
    style === Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
  ) {
    return createBingIonImagery(style, accessToken);
  }
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

async function createBingIonImagery(style, accessToken) {
  const endpoint = await new Cesium.Resource({
    url: `https://api.cesium.com/v1/assets/${style}/endpoint`,
    queryParameters: { access_token: accessToken },
  }).fetchJson();
  if (
    endpoint?.type !== 'IMAGERY' ||
    endpoint.externalType !== 'BING' ||
    typeof endpoint.options?.url !== 'string'
  ) {
    throw new Error('Ion world imagery did not return a Bing imagery endpoint');
  }
  // Bing otherwise follows the page's HTTP scheme on localhost. Resolve its
  // ion-issued credentials through public APIs so tiles use HTTPS without
  // weakening CSP, changing SDK defaults or touching provider internals.
  const { url, ...options } = endpoint.options;
  const provider = await Cesium.BingMapsImageryProvider.fromUrl(url, {
    ...options,
    tileProtocol: 'https',
  });
  const ionCredits = (endpoint.attributions ?? []).map(
    ({ html, collapsible }) => new Cesium.Credit(html, collapsible === false),
  );
  const getTileCredits = provider.getTileCredits.bind(provider);
  provider.getTileCredits = (x, y, level) => [
    ...ionCredits,
    ...(getTileCredits(x, y, level) ?? []),
  ];
  return provider;
}

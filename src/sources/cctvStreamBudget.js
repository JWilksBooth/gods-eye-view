/**
 * The camera proxy's live-video budget, shared by the server that enforces
 * it (server/providers/cctv/stream.js) and the browser surfaces that plan
 * against it (the camera wall). One number in one place: a wall that asks
 * for a third stream would otherwise learn the limit only from a 503.
 *
 * - `CCTV_HLS_SESSION_LIMIT`: distinct cameras the proxy pulls at once. A
 *   second viewer of the same camera shares its session through a lease.
 * - `CCTV_HLS_LEASES_PER_SESSION`: viewers one pulled camera may serve.
 */
export const CCTV_HLS_SESSION_LIMIT = 2;
export const CCTV_HLS_LEASES_PER_SESSION = 8;

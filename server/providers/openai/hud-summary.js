import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

const HUD_SUMMARY_BASE_URL_DEFAULT = 'https://api.openai.com/v1';
const HUD_SUMMARY_REASONING_EFFORT_DEFAULT = 'minimal';

/**
 * Where the HUD summary is generated. GEV_HUD_SUMMARY_BASE_URL points the
 * Responses call at any OpenAI-compatible server (Ollama, LM Studio, a
 * proxy) without touching the Realtime voice path, which stays on OpenAI.
 */
function hudSummaryEndpoint(env = process.env) {
  const base =
    String(env.GEV_HUD_SUMMARY_BASE_URL ?? '')
      .trim()
      .replace(/\/+$/, '') || HUD_SUMMARY_BASE_URL_DEFAULT;
  return `${base}/responses`;
}

/**
 * Credential for the HUD summary call: its own key, else the OpenAI key. A
 * local base URL needs none; a placeholder keeps the bearer header well-formed
 * and the capability probe truthful.
 */
function hudSummaryCredential(env = process.env) {
  const own = String(env.GEV_HUD_SUMMARY_API_KEY ?? '').trim();
  if (own) return own;
  const openai = String(env.OPENAI_API_KEY ?? '').trim();
  if (openai) return openai;
  return String(env.GEV_HUD_SUMMARY_BASE_URL ?? '').trim() ? 'local' : '';
}

/** Thinking models need `none` here or they spend the token budget reasoning. */
function hudSummaryReasoningEffort(env = process.env) {
  return (
    String(env.GEV_HUD_SUMMARY_REASONING_EFFORT ?? '').trim() ||
    HUD_SUMMARY_REASONING_EFFORT_DEFAULT
  );
}

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  // Capability probe: lets the HUD skip its paid place lookups when there is
  // no summary to feed them to.
  if (req.method === 'GET' && req.url?.split('?')[0] === '/status') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        configured: !keylessHudSummaryResponse(hudSummaryCredential()),
      }),
    );
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = hudSummaryCredential();
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const response = await fetch(hudSummaryEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:
          process.env.OPENAI_HUD_SUMMARY_MODEL ||
          OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: HUD_SUMMARY_INSTRUCTIONS,
        input: JSON.stringify(context),
        reasoning: { effort: hudSummaryReasoningEffort() },
        max_output_tokens: 100,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error: response.ok ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export {
  handleHudSummary,
  hudSummaryCredential,
  hudSummaryEndpoint,
  hudSummaryReasoningEffort,
};

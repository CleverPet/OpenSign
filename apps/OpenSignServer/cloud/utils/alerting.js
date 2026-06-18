import axios from 'axios';

/**
 * Lightweight error alerting for OpenSign cloud functions.
 *
 * Transport (first configured wins):
 *   1. SLACK_ALERT_WEBHOOK_URL  — Slack incoming-webhook URL (simplest, no scopes)
 *   2. SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL — chat.postMessage (bot must be in the channel)
 *   3. none — logs locally only (no-op transport, never throws)
 *
 * Designed to be fire-and-forget: callers do NOT await, and this never throws,
 * so alerting can never affect the request it is reporting on.
 */

const WEBHOOK = () => process.env.SLACK_ALERT_WEBHOOK_URL;
const BOT_TOKEN = () => process.env.SLACK_BOT_TOKEN;
const CHANNEL = () => process.env.SLACK_ALERT_CHANNEL;
const ENVNAME = () => process.env.NODE_ENV || process.env.RENDER_SERVICE_NAME || 'unknown';

// In-memory throttle so a hot loop of the same error can't flood Slack.
// Key = fn + error message; suppress repeats within the window.
const THROTTLE_MS = 5 * 60 * 1000;
const lastSent = new Map();
function throttled(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < THROTTLE_MS) return true;
  lastSent.set(key, now);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (lastSent.size > 500) {
    for (const [k, t] of lastSent) if (now - t > THROTTLE_MS) lastSent.delete(k);
  }
  return false;
}

function buildMessage(context, err) {
  const name = err?.name || 'Error';
  const message = err?.message || String(err);
  const stack = String(err?.stack || '')
    .split('\n')
    .slice(0, 5)
    .join('\n');
  const ctxLines = [];
  if (context?.fn) ctxLines.push(`*fn:* \`${context.fn}\``);
  if (context?.docId) ctxLines.push(`*docId:* \`${context.docId}\``);
  if (context?.path) ctxLines.push(`*path:* \`${context.path}\``);
  return (
    `:rotating_light: *OpenSign error* (${ENVNAME()})\n` +
    `${ctxLines.join('  ')}\n` +
    `*${name}:* ${message}\n` +
    '```' + stack + '```'
  );
}

export function reportError(context, err) {
  try {
    const key = `${context?.fn || context?.path || '?'}:${err?.message || String(err)}`;
    if (throttled(key)) return;
    const text = buildMessage(context, err);

    const webhook = WEBHOOK();
    const botToken = BOT_TOKEN();
    const channel = CHANNEL();

    if (webhook) {
      axios.post(webhook, { text }, { timeout: 5000 }).catch(e => {
        console.log('[alerting] webhook post failed:', e?.message);
      });
    } else if (botToken && channel) {
      axios
        .post(
          'https://slack.com/api/chat.postMessage',
          { channel, text },
          { headers: { Authorization: `Bearer ${botToken}` }, timeout: 5000 }
        )
        .then(r => {
          if (r?.data && r.data.ok === false) {
            console.log('[alerting] slack api error:', r.data.error);
          }
        })
        .catch(e => console.log('[alerting] chat.postMessage failed:', e?.message));
    } else {
      console.log('[alerting] (no Slack configured) ' + text.replace(/\n/g, ' | '));
    }
  } catch (e) {
    // Alerting must never break the caller.
    console.log('[alerting] reportError threw:', e?.message);
  }
}

/**
 * Wrap Parse.Cloud.define so EVERY cloud function reports when it either
 * throws OR returns a raw Error instance (OpenSign functions frequently catch
 * internally and `return err`, which Parse serializes into a generic client
 * error — the exact failure mode that hid the getDocument TenantId crash).
 *
 * Intentional business responses like `return { error: "access denied" }`
 * (a plain object, not an Error) are NOT alerted, so this stays low-noise.
 *
 * Call ONCE before any Parse.Cloud.define() calls.
 */
export function installCloudErrorReporting(Parse) {
  if (Parse.Cloud.__errorReportingInstalled) return;
  const origDefine = Parse.Cloud.define.bind(Parse.Cloud);
  Parse.Cloud.define = function (name, handler, ...rest) {
    if (typeof handler !== 'function') return origDefine(name, handler, ...rest);
    const wrapped = async request => {
      const ctx = {
        fn: name,
        docId: request?.params?.docId || request?.params?.documentId,
      };
      try {
        const result = await handler(request);
        if (result instanceof Error) reportError(ctx, result);
        return result;
      } catch (err) {
        reportError(ctx, err);
        throw err;
      }
    };
    return origDefine(name, wrapped, ...rest);
  };
  Parse.Cloud.__errorReportingInstalled = true;

  // Backstop for truly fatal errors that escape all handlers.
  process.on('unhandledRejection', reason => {
    reportError({ fn: 'unhandledRejection' }, reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', err => {
    reportError({ fn: 'uncaughtException' }, err);
  });
}

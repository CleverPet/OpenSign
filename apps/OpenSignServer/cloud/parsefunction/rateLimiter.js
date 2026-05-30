import { RateLimiterMemory } from 'rate-limiter-flexible';

const WINDOW = 15 * 60; // 15 minutes in seconds

// Limits target abusive patterns, not normal app usage.
// Authenticated requests bypass the general limiter — the UI fires many
// background calls (status checks, polling, navigation) that would otherwise
// exhaust per-IP budgets and cause spurious logouts.
const authLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const otpSendLimiter = new RateLimiterMemory({ points: 5, duration: WINDOW });
const otpVerifyLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const emailLimiter = new RateLimiterMemory({ points: 100, duration: WINDOW });
const publicSignLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const publicTemplateLimiter = new RateLimiterMemory({ points: 30, duration: WINDOW });
const signPdfLimiter = new RateLimiterMemory({ points: 20, duration: WINDOW });
const fileConvertLimiter = new RateLimiterMemory({ points: 20, duration: WINDOW });
const deleteAccountLimiter = new RateLimiterMemory({ points: 5, duration: WINDOW });
// General limiter only applies to UNAUTHENTICATED requests — high enough that
// normal browsing isn't blocked, low enough to deter scraping/abuse.
const generalLimiter = new RateLimiterMemory({ points: 300, duration: WINDOW });

// Map URL path suffixes to specific limiters (these always apply)
const FUNCTION_LIMITERS = {
  'googleLogin': authLimiter,
  'loginuser': authLimiter,
  'usersignup': authLimiter,
  'addadmin': authLimiter,
  'SendOTPMailV1': otpSendLimiter,
  'AuthLoginAsMail': otpVerifyLimiter,
  'sendmailv3': emailLimiter,
  'createPublicSigningDoc': publicSignLimiter,
  'getPublicTemplate': publicTemplateLimiter,
  'signPdf': signPdfLimiter,
};

const PATH_LIMITERS = {
  '/docxtopdf': fileConvertLimiter,
  '/decryptpdf': fileConvertLimiter,
};

function getSpecificLimiter(req) {
  const path = req.path || '';

  // Cloud function endpoints: /app/functions/<name> or /functions/<name>
  const funcMatch = path.match(/\/functions\/(\w+)$/);
  if (funcMatch) {
    return FUNCTION_LIMITERS[funcMatch[1]] || null;
  }

  // Custom Express routes
  for (const [prefix, limiter] of Object.entries(PATH_LIMITERS)) {
    if (path.startsWith(prefix)) return limiter;
  }

  // Delete account paths
  if (path.includes('/delete-account')) return deleteAccountLimiter;

  return null;
}

function hasSessionToken(req) {
  return Boolean(
    req.headers['x-parse-session-token'] ||
    req.headers['sessiontoken'] ||
    req.headers['session-token']
  );
}

export async function rateLimitMiddleware(req, res, next) {
  // Skip internal localhost calls (cloud function → cloud function via master key)
  const ip = req.headers['x-real-ip'] || req.ip || '127.0.0.1';
  if (ip === '127.0.0.1' || ip === '::1') {
    return next();
  }

  const specific = getSpecificLimiter(req);
  const limiter = specific || (hasSessionToken(req) ? null : generalLimiter);

  // Authenticated requests without a specific abuse-vector endpoint pass through
  if (!limiter) return next();

  try {
    await limiter.consume(ip);
    next();
  } catch (rateLimiterRes) {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000) || WINDOW;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
}

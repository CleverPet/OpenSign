import { RateLimiterMemory } from 'rate-limiter-flexible';

const WINDOW = 15 * 60; // 15 minutes in seconds

// Strict limits for auth and email endpoints
const authLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const otpSendLimiter = new RateLimiterMemory({ points: 5, duration: WINDOW });
const otpVerifyLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const emailLimiter = new RateLimiterMemory({ points: 30, duration: WINDOW });
const publicSignLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const publicTemplateLimiter = new RateLimiterMemory({ points: 30, duration: WINDOW });
const signPdfLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const fileConvertLimiter = new RateLimiterMemory({ points: 10, duration: WINDOW });
const deleteAccountLimiter = new RateLimiterMemory({ points: 5, duration: WINDOW });
const generalLimiter = new RateLimiterMemory({ points: 100, duration: WINDOW });

// Map URL path suffixes to specific limiters
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

function getLimiter(req) {
  const path = req.path || '';

  // Check cloud function name: /app/functions/<name> or /functions/<name>
  const funcMatch = path.match(/\/functions\/(\w+)$/);
  if (funcMatch) {
    return FUNCTION_LIMITERS[funcMatch[1]] || generalLimiter;
  }

  // Check custom route paths
  for (const [prefix, limiter] of Object.entries(PATH_LIMITERS)) {
    if (path.startsWith(prefix)) return limiter;
  }

  // Delete account paths
  if (path.includes('/delete-account')) return deleteAccountLimiter;

  return generalLimiter;
}

export async function rateLimitMiddleware(req, res, next) {
  // Skip rate limiting for internal localhost calls (cloud function → cloud function)
  const ip = req.headers['x-real-ip'] || req.ip || '127.0.0.1';
  if (ip === '127.0.0.1' || ip === '::1') {
    return next();
  }

  const limiter = getLimiter(req);
  try {
    await limiter.consume(ip);
    next();
  } catch (rateLimiterRes) {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000) || WINDOW;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
}

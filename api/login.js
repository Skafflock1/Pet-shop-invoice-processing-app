/*
 * Vercel serverless function — checks a submitted PIN against the
 * server-side ACCESS_PIN env var and, on success, sets a signed HttpOnly
 * cookie that middleware.js accepts as an authenticated session. See
 * middleware.js for the gate itself and README "Access protection".
 */

const crypto = require('crypto');

const COOKIE_NAME = 'psi_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days, matches middleware.js

function getSecret() {
  const pin = process.env.ACCESS_PIN;
  return process.env.SESSION_SECRET || (pin ? `psi-demo-salt:${pin}` : null);
}

function signHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only.' });
    return;
  }

  const pin = process.env.ACCESS_PIN;
  if (!pin) {
    res.status(500).json({ error: 'This deployment is missing the ACCESS_PIN environment variable.' });
    return;
  }

  const submitted = String((req.body || {}).pin || '');
  const a = Buffer.from(submitted);
  const b = Buffer.from(pin);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    res.status(401).json({ error: 'Wrong PIN.' });
    return;
  }

  const token = signHex(getSecret(), 'authorized');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
  res.status(200).json({ ok: true });
};

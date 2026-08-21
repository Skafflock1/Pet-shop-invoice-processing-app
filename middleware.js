/*
 * Vercel Edge Middleware — a single shared-PIN gate in front of the whole
 * app (static files and /api/*), so the deployed URL can't be found and
 * used by random visitors to run (and pay for) recognition calls.
 *
 * This is intentionally NOT a full auth system, per the brief: one shared
 * PIN, one signed cookie, no accounts, no database. It deters casual/
 * opportunistic use of a discovered URL; it is not meant to resist a
 * determined attacker.
 *
 * Required env var: ACCESS_PIN — the shared PIN visitors must enter.
 * Optional env var: SESSION_SECRET — signs the session cookie. If unset,
 * a secret is derived from ACCESS_PIN, so the gate works with zero extra
 * config; setting SESSION_SECRET explicitly is better hygiene (it means
 * rotating the PIN doesn't also invalidate every open session, and vice
 * versa) — see README "Access protection".
 */

export const config = {
  matcher: ['/((?!api/login).*)'],
};

const COOKIE_NAME = 'psi_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function getSecret() {
  const pin = process.env.ACCESS_PIN;
  return process.env.SESSION_SECRET || (pin ? `psi-demo-salt:${pin}` : null);
}

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function middleware(req) {
  const pin = process.env.ACCESS_PIN;
  if (!pin) {
    // No PIN configured — fail open rather than lock out the deployer by
    // surprise. Set ACCESS_PIN before sharing the URL; see README.
    return;
  }

  const secret = getSecret();
  const url = new URL(req.url);
  const cookie = getCookie(req, COOKIE_NAME);
  const expected = await hmacHex(secret, 'authorized');

  if (cookie === expected) return; // valid session — let the request through

  const accept = req.headers.get('accept') || '';
  const wantsJson = url.pathname.startsWith('/api/') || accept.includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify({ error: 'Unauthorized — enter the access PIN first.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(LOGIN_HTML, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pet Shop Invoice Assistant</title>
<style>
  :root { --bg:#F6F4EF; --surface:#FFFFFF; --text:#1E2422; --text-muted:#6B7169; --border:#E6E1D6; --primary:#276A4E; --primary-dark:#1C523C; --radius:16px; --radius-sm:10px; --danger:#B42318; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--text); padding:20px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:28px 24px; width:100%; max-width:340px; box-shadow:0 1px 2px rgba(20,24,22,.04),0 6px 20px rgba(20,24,22,.06); text-align:center; }
  .logo { font-size:36px; margin-bottom:8px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { font-size:13px; color:var(--text-muted); margin:0 0 20px; }
  input { width:100%; border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:12px; font-size:16px; text-align:center; letter-spacing:2px; margin-bottom:12px; }
  input:focus { outline:none; border-color:var(--primary); }
  button { width:100%; border:none; border-radius:var(--radius-sm); padding:12px; font-weight:700; font-size:14px; background:var(--primary); color:#fff; cursor:pointer; }
  button:hover { background:var(--primary-dark); }
  button:disabled { opacity:.6; cursor:not-allowed; }
  .error { color:var(--danger); font-size:12.5px; min-height:16px; margin-top:10px; }
</style>
</head>
<body>
  <form class="card" id="gateForm">
    <div class="logo">🐾</div>
    <h1>Pet Shop Invoice Assistant</h1>
    <p>Enter the access PIN to continue.</p>
    <input type="password" id="pinInput" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus />
    <button type="submit" id="gateSubmit">Continue</button>
    <div class="error" id="gateError"></div>
  </form>
  <script>
    var form = document.getElementById('gateForm');
    var input = document.getElementById('pinInput');
    var err = document.getElementById('gateError');
    var btn = document.getElementById('gateSubmit');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Checking…';
      fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin: input.value }),
      }).then(function (res) {
        if (res.ok) { window.location.reload(); return; }
        return res.json().then(function (data) {
          err.textContent = (data && data.error) || 'Wrong PIN.';
          btn.disabled = false;
          btn.textContent = 'Continue';
          input.value = '';
          input.focus();
        });
      }).catch(function () {
        err.textContent = 'Network error — try again.';
        btn.disabled = false;
        btn.textContent = 'Continue';
      });
    });
  </script>
</body>
</html>`;

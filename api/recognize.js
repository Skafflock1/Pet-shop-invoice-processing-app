/*
 * Vercel serverless function — holds the Anthropic API key server-side so
 * "Live Claude recognition" mode works for visitors with no key of their
 * own. Never returns the key or forwards it to the client.
 *
 * Deploy: import this repo on vercel.com, set the ANTHROPIC_API_KEY
 * environment variable in the project's Settings -> Environment Variables,
 * deploy. No other config needed — see README.md "Deploying the backend".
 *
 * POST /api/recognize
 *   body: { model: string, images: [{ mediaType: string, data: base64 }] }
 *   -> 200 { extracted: <record_invoice tool input>, usage }
 *   -> 4xx/5xx { error: string }
 */

const { INVOICE_TOOL, LIVE_SYSTEM_PROMPT, LIVE_MODELS } = require('../js/invoice-tool.js');

const ALLOWED_MODELS = LIVE_MODELS.map(m => m.id);
const MAX_IMAGES = 6; // a cheap guard against runaway cost on this public, unauthenticated demo endpoint

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'This deployment is missing the ANTHROPIC_API_KEY environment variable — see README.md.' });
    return;
  }

  const body = req.body || {};
  const { model, images } = body;

  if (!ALLOWED_MODELS.includes(model)) {
    res.status(400).json({ error: `Unsupported model. Use one of: ${ALLOWED_MODELS.join(', ')}.` });
    return;
  }
  if (!Array.isArray(images) || images.length === 0) {
    res.status(400).json({ error: 'No images provided.' });
    return;
  }
  if (images.length > MAX_IMAGES) {
    res.status(400).json({ error: `Too many photos — send at most ${MAX_IMAGES} pages per invoice.` });
    return;
  }
  for (const img of images) {
    if (!img || typeof img.data !== 'string' || !img.data) {
      res.status(400).json({ error: 'Each image needs base64 data.' });
      return;
    }
  }

  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data },
    })),
    { type: 'text', text: `These are ${images.length} photo(s) of one supplier invoice, in order. Extract it with the record_invoice tool.` },
  ];

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: LIVE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        tools: [INVOICE_TOOL],
        tool_choice: { type: 'tool', name: 'record_invoice' },
      }),
    });

    if (!anthropicRes.ok) {
      let detail = '';
      try { detail = (await anthropicRes.json()).error?.message || ''; } catch (e) { /* ignore */ }
      res.status(anthropicRes.status).json({ error: detail || `Claude API error ${anthropicRes.status}` });
      return;
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) {
      res.status(502).json({ error: 'Claude responded without structured data — try again.' });
      return;
    }
    res.status(200).json({ extracted: toolUse.input, usage: data.usage });
  } catch (err) {
    res.status(502).json({ error: err && err.message ? err.message : 'Failed to reach the Claude API.' });
  }
};

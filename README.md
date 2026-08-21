# Pet Shop Invoice Assistant — Demo

A clickable browser prototype for the invoice-entry app described in the TZ
(`TZ_invoice_app.pdf`): a chain of 6+ pet shops in Cyprus wants to replace
manual double-entry of supplier invoices with a photo-in, stock-out flow.

This is a **UX demo**, not the production app — see "What's real vs.
simulated" below. It exists to validate the flow and screen design with
Alexandros before writing the real recognition/backend integration.

## Running it

No build step, no dependencies. Any static file server works:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Or open `index.html` directly in a browser (the service worker won't
register over `file://`, but the app works fine without it).

Best viewed on a phone-sized viewport — the whole app is designed mobile
first, since staff use personal phones on the shop floor.

## Try it

1. **Sign in** as one of three demo profiles — Elena (employee), Marios
   (manager), or Alexandros (owner). Any access code is accepted.
2. **Confirm a store** — required every session, never assumed.
3. Tap **New Invoice**, pick one of the three sample suppliers, add a photo
   (or use "Simulate a blurry photo" to see the retake prompt), then **Start
   recognition**.
4. Try all three samples to see the different situations the TZ calls out:
   - **Propet Cyprus** — clean run with two handwritten/low-confidence
     fields to confirm, plus a pack-multiplier check that matches.
   - **VetLine Supplies** — only page 1 was "photographed"; the totals
     don't add up and the app asks for the missing pages instead of posting
     silently.
   - **AquaWorld Distributors** — a pack-size mismatch against the product
     card, one unknown barcode (single new-product flow), and a batch of 10
     new flavours (shared-fields batch flow). Sign in as Elena to see how
     the employee role is blocked from creating products and has to flag
     them for a manager instead.
5. **History** shows past entries with who/when/store, and a locked
   "in progress" draft that only the owner can reassign.
6. **Products** (manager/owner only) lists the product master data used for
   pack-multiplier checks.

Demo data resets automatically if you clear site storage; there's no
"reset" button in the UI (add one if it's useful for a live demo).

## Live recognition (real Claude API calls)

On the capture screen there's a second mode next to "Sample invoice":
**🔴 Live Claude recognition**. Switch to it, pick a model, and add real
photos of an actual invoice (or any document) — the app sends them to
Claude and asks it to extract the header and line items with a forced tool
call (`record_invoice`), then runs the result through the exact same
clarification/mismatch/new-product pipeline as the scripted samples. This
is genuinely calling the model, not another canned response.

**Nobody has to paste an API key.** The app calls its own backend at
`POST /api/recognize` (`api/recognize.js`), a small serverless function
that holds `ANTHROPIC_API_KEY` as a server-side environment variable and
forwards the request — the key never reaches the browser. See "Deploying
the backend" below to stand this up; once it's deployed, live recognition
just works for anyone who opens the site.

If no backend answers (these files served as plain static files with no
`/api` route, or opened as a claude.ai Artifact preview), the app falls
back to offering a "paste your own key and call Claude directly from this
browser" option — the same client-side-key pattern from the previous
version of this demo, kept only as a fallback for local/static hosting. It
says so plainly in-app when that path is used, since it's a demo-only
pattern a real product must never ship.

**Try it with something messy** — a photo with a bit of handwriting, an
unfamiliar barcode, a smudge — to see Claude flag it as low-confidence
(🔴 badge) or offer to create a new product from a barcode it's never seen,
exactly like the scripted AquaWorld sample does with fabricated data. Real
invoices won't match the demo's fake barcode database, so almost every
line comes back as a new product — that's expected, and arguably the most
convincing part to show a client live.

Cost is small — a few cents per invoice at most; see the model picker for
a rough per-invoice estimate for each option.

## Deploying the backend

Any host that runs a Node serverless function next to static files works;
these steps are for [Vercel](https://vercel.com), which needs no config
file for a project shaped like this one.

1. Push this repo to GitHub (already done if you're reading this there).
2. On [vercel.com](https://vercel.com), **Add New → Project**, import the
   repo. Framework preset: **Other**. Leave the build command empty and
   the output directory as the project root — there's no build step.
3. Before the first deploy (or after, under **Settings → Environment
   Variables**), add **`ANTHROPIC_API_KEY`** with a real key from
   [console.anthropic.com](https://console.anthropic.com). Apply it to
   Production (and Preview, if you want preview deploys to work too).
4. Deploy. Vercel gives you a public `https://<project>.vercel.app` URL —
   the static site and `/api/recognize` both live there, same origin, no
   CORS config needed.
5. Optional: this endpoint is public and unauthenticated once deployed —
   anyone who has the URL can trigger a real (cheap, but non-zero) API
   call. `api/recognize.js` caps requests at 6 images as a basic abuse
   guard, but for a link you're sharing beyond a trusted demo audience,
   turn on Vercel's **Deployment Protection** (a password, no code
   required) under project settings.

Netlify Functions, Cloudflare Workers, or a small Express server all work
too with minor adaptation — `api/recognize.js` is a plain
`(req, res) => {...}` handler with no Vercel-specific imports.

## What's real vs. simulated

| Area | This demo | Production (per TZ) |
|---|---|---|
| Photo capture / upload | Real — uses the actual camera/file picker | same |
| Invoice recognition (**Sample invoice** mode) | **Scripted** — you pick a sample supplier, the app reveals canned OCR output | — |
| Invoice recognition (**Live Claude recognition** mode, backend deployed) | **Real** — genuine Claude API call with vision + forced tool use, key held server-side | same architecture |
| Invoice recognition (**Live Claude recognition** mode, no backend) | **Real**, but via a visitor-pasted key called directly from the browser — fallback only | — |
| Blurry-photo detection | **Scripted** — a manual "simulate" toggle, no real image analysis (sample mode only) | real image-quality check before OCR |
| Totals cross-check, missing-page detection | Real logic, run against either the scripted or live-extracted data | same logic |
| Clarification queue, pack-multiplier checks, new-product flow, batch flow | Real, interactive | same |
| Roles (employee/manager/owner) | Real gating in the UI | same, backed by real auth |
| Weekly access code | Cosmetic field, accepts anything | real weekly code tied to store Wi-Fi code |
| Multi-store data, audit trail | `localStorage` on this device only | shared DB, synced in real time across stores |
| Store "suggestion" | Hardcoded to the first store on the profile | geolocation / local network match |

## Mapping to the TZ

- §1 Recognition, unified capture, header fields, auto-check — capture →
  review screens.
- §2 Ambiguity handling, pack multiplier — clarification queue on Review.
- §3 Photo quality gate, missing-page detection (`Page X of Y` + totals
  mismatch) — recognition step + the Review banner (see VetLine sample).
- §4 New/existing product handling, inline creation, batch mode — the
  `new_product` / `batch_new` clarification cards (see AquaWorld sample).
- §5 Roles, weekly code, invoice→employee attribution, draft locking —
  login, role gating throughout, History's locked draft.
- §6 Multi-store — store confirmation every session, owner's all-store
  overview and History filter, per-entry store/employee/timestamp.
- §7 PWA — plain HTML/CSS/JS, installable via `manifest.webmanifest` +
  `sw.js`, camera access via the standard file input.

## Next steps toward the real thing

1. Tune the extraction prompt/schema (`js/invoice-tool.js`) against
   Alexandros's real supplier invoices (TZ §8) rather than the generic one
   used here.
2. Add basic auth/rate-limiting in front of `/api/recognize` before
   sharing the deployed URL widely — right now it's an open door to
   whoever's paying for the API key (see "Deploying the backend").
3. Replace `localStorage` with the existing DB via the API/endpoint
   Alexandros provides (TZ §8).
4. Real auth (weekly codes) and a real geolocation/Wi-Fi store suggestion.
5. Wire the "Add product" standalone screen (currently a stub) into the
   same product-card component used inline during invoice entry.

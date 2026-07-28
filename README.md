# Smart Lawn Watering Assistant

A phase-aware watering assistant for a newly seeded lawn: frequent light misting during germination, daily deeper watering while roots establish, then a weekly cumulative rain+irrigation target once the lawn is established. Built as a single-file PWA-style page + Supabase backend, with an optional scheduled email alert so you get pinged even when the app is closed.

## Already done for your project (`mhmaoibfdpvautmxteet`)

- ✅ `schema.sql` has been applied — `water_logs`, `lawn_settings`, `alert_history` all exist with RLS policies.
- ✅ `index.html` is already wired up with your project's URL and anon key — nothing to paste in.
- ✅ The `watering-check` Edge Function is deployed at `https://mhmaoibfdpvautmxteet.supabase.co/functions/v1/watering-check`.

Just open [`index.html`](index.html) in a browser (double-click it, or host it — see step 4 below). First run walks you through a Setup screen: seed date, grass type (Kentucky Bluegrass preset is pre-selected), location, and an alert email.

## 1. Set up background email alerts (optional but recommended)

The Edge Function is deployed, but it needs two things from you before it can actually send email — I didn't set these since they're your Resend account's own credentials:

1. **Get a Resend API key** (free tier is plenty): sign up at [resend.com](https://resend.com), create an API key. For testing you can send from `onboarding@resend.dev` with no extra setup; to send from your own address, verify a domain in Resend first.
2. **Set the secrets** — either via the Supabase Dashboard (Project → Edge Functions → Secrets) or, if you have the CLI (`npm install -g supabase`, then `supabase link --project-ref mhmaoibfdpvautmxteet`):
   ```bash
   supabase secrets set RESEND_API_KEY=re_your_key_here
   supabase secrets set RESEND_FROM_EMAIL="Lawn Watering Assistant <onboarding@resend.dev>"
   ```
3. **Schedule it.** In the Supabase Dashboard → Edge Functions → `watering-check` → Cron, create three schedules pointing at the function with a different `slot` query param each (times are whatever fits your day — these are just suggestions):
   - `0 12 * * *` → `.../watering-check?slot=morning` (≈7am local if you're UTC-6 Central)
   - `0 18 * * *` → `.../watering-check?slot=midday`
   - `0 23 * * *` → `.../watering-check?slot=evening`

   During Germination, all three slots evaluate (you want 2–3 light-mist reminders/day). Once the lawn moves into Root Development or Establishment, the function automatically skips the `midday`/`evening` slots and only evaluates once/day on `morning` — no need to change the schedule when the phase changes.

To test without waiting for the cron, from the Dashboard's function page use "Invoke", or via CLI: `supabase functions invoke watering-check` — check your inbox. Until you fill out Setup in the app (which writes the `lawn_settings` row) or set the Resend secrets, invoking it will just report back why it didn't send (no settings / no email configured / no Resend key).

## 2. Using the app

- **Dashboard** shows your current phase ("Day N · Germination/Root Development/Establishment"), a status pill, and metrics that adapt to the phase (moisture in the last 8h during germination, today's progress during root development, weekly cumulative progress once established).
- **+ button** logs a manual irrigation or rain entry — enter inches directly, or minutes at your sprinkler's inches/hour rate.
- **Notification Center** always shows the current recommendation plus the last few emails the background job sent, so nothing is hidden even if you skip email.
- **Enable Alerts** requests browser notification permission for foreground/backgrounded alerts while the app is open.
- **⚙️ gear icon** re-opens Setup to edit seed date, grass type, phase-length thresholds, weekly targets, location, or alert email at any time.

## 3. Installing on your iPhone (PWA feel)

Host `index.html` somewhere reachable over HTTPS (GitHub Pages is easiest — just push this repo and enable Pages), then on your iPhone:
1. Open the page in Safari.
2. Tap the Share icon → **Add to Home Screen**.
3. It now launches full-screen from your home screen like a native app.

## Notes & tradeoffs

- **RLS is permissive.** `schema.sql` allows any request bearing your anon key to read/write these tables. That's fine for a private single-user tool, but don't publish the URL/anon key publicly — if you ever do, switch to Supabase Auth and scope policies to `auth.uid()`.
- **Weather source:** [Open-Meteo](https://open-meteo.com) — free, no API key required. Historical/forecast precipitation is model-based, not a rain gauge; logging your own rain readings in the app (type = "rain") overrides/supplements it for that entry.
- **Why email instead of native push:** true background push notifications on iOS (via installed PWA + Web Push) need a service worker, VAPID keypair, and a push-subscription table, and are flaky across iOS versions. A cron-scheduled email is simpler, more reliable, and works regardless of whether the app is installed. If you want native-feeling push later, that's a clean follow-on addition once this is running.

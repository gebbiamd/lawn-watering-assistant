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

- **Dashboard** shows your current phase ("Day N · Germination/Root Development/Establishment"), a status pill with both the current recommendation *and* a concrete "Next watering: Today at 3:25 PM (in 41m) — 0.05" (≈6 min)" line — an actual clock time, a countdown, and the amount in both inches and sprinkler minutes.
- **Soil Moisture gauge** — an animated thermometer that empties from "Moist" (green) through "Getting Dry" (amber) to "Water Needed"/"Critically Dry" (red, pulsing) as the current watering interval elapses. It ticks on its own every minute between refreshes, so it visibly counts down in real time.
- **Frequency, not just amount:** watering cadence is phase-driven — Germination waters `germination_sessions_per_day` times/day (default 3, light sessions), Root Development tapers daily → every-other-day as it approaches Establishment, and Establishment waters every `establishment_interval_days` (default 3.5, ~2×/week), deep sessions. Both settings are editable in Setup and per-grass-type presets.
- **Rain-skip is gated on both amount and confidence:** the app already used the forecasted *amount* of rain (not just the % chance) to decide whether to skip — now it also requires the probability to clear 40% before skipping, so a low-confidence forecast won't cancel a needed watering.
- **Never recommends watering overnight:** prolonged nighttime leaf wetness is the biggest driver of turf fungal disease (brown patch, dollar spot) per NC State/Purdue extension research, so a Root Development/Establishment deep soak that would naturally fall in the 8pm–6am window gets pushed to the next 6:00 AM instead — the banner shows "Hold Until Morning" rather than telling you to go water at midnight. Germination's brief, quick-drying misting is exempt when it's already overdue, since letting the seed dry out is the bigger risk there.
- **Sprinkler rate (in/hr)** in Setup converts every recommended amount into minutes to run your actual sprinkler/hose — set it once (0.5"/hr default) and every "how much" in the app speaks in minutes, not just inches.
- **+ button** logs a manual irrigation or rain entry — enter inches directly, or minutes at your sprinkler's inches/hour rate (pre-filled from your Setup rate).
- **Notification Center** always shows the current recommendation plus the last few emails the background job sent, so nothing is hidden even if you skip email.
- **Enable Alerts** requests browser notification permission for foreground/backgrounded alerts while the app is open.
- **⚙️ gear icon** re-opens Setup to edit seed date, grass type, phase-length thresholds, weekly/session targets, watering frequency, location, or alert email at any time.

## 3. Installing on your iPhone (PWA feel)

Host `index.html` somewhere reachable over HTTPS (GitHub Pages is easiest — just push this repo and enable Pages), then on your iPhone:
1. Open the page in Safari.
2. Tap the Share icon → **Add to Home Screen**.
3. It now launches full-screen from your home screen like a native app.

## Notes & tradeoffs

- **RLS is permissive.** `schema.sql` allows any request bearing your anon key to read/write these tables. That's fine for a private single-user tool, but don't publish the URL/anon key publicly — if you ever do, switch to Supabase Auth and scope policies to `auth.uid()`.
- **Weather source:** [Open-Meteo](https://open-meteo.com) — free, no API key required. Historical/forecast precipitation is model-based, not a rain gauge; logging your own rain readings in the app (type = "rain") overrides/supplements it for that entry.
- **Why email instead of native push:** true background push notifications on iOS (via installed PWA + Web Push) need a service worker, VAPID keypair, and a push-subscription table, and are flaky across iOS versions. A cron-scheduled email is simpler, more reliable, and works regardless of whether the app is installed. If you want native-feeling push later, that's a clean follow-on addition once this is running.

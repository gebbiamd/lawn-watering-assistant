// Smart Lawn Watering Assistant — scheduled background check.
//
// Deploy:   supabase functions deploy watering-check
// Secrets:  supabase secrets set RESEND_API_KEY=re_xxx
//           supabase secrets set RESEND_FROM_EMAIL="Lawn Assistant <onboarding@resend.dev>"
// Schedule: create 3 Cron Jobs (Supabase Dashboard > Edge Functions > watering-check > Cron)
//           pointing at this function with a different `slot` query param each:
//             7:00 local  -> ?slot=morning
//             13:00 local -> ?slot=midday
//             18:00 local -> ?slot=evening
//           Germination phase uses all 3 slots; Root Development / Establishment
//           only evaluate on the `morning` slot (once/day is enough for those phases).
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically by the
// Supabase Edge Runtime — no need to set them as secrets yourself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SATURATION_48H_THRESHOLD = 0.50;
const RAIN_FORECAST_THRESHOLD = 0.25;
const MOISTURE_LOOKBACK_HOURS = 8;
const MOISTURE_LOOKBACK_THRESHOLD = 0.05;
const DEDUPE_WINDOW_HOURS = 4;

const STATUS_META: Record<string, { emoji: string; label: string }> = {
  skip_rain:        { emoji: '🔵', label: 'SKIP - RAIN FORECASTED' },
  skip_saturated:   { emoji: '🔵', label: 'SKIP WATERING' },
  water_now_mist:   { emoji: '🟡', label: 'Water Now (Light Mist)' },
  skip_moist:       { emoji: '🟢', label: 'Soil Moist — Skip' },
  water_now_deep:   { emoji: '🟡', label: 'Water Now (Deep Session)' },
  on_track_today:   { emoji: '🟢', label: 'On Track Today' },
  water_now_weekly: { emoji: '🟢', label: 'Safe to Water' },
  on_track_week:    { emoji: '🟢', label: 'Target Met This Week' },
};
const NOTIFIABLE_KEYS = new Set([
  'water_now_mist', 'water_now_deep', 'water_now_weekly', 'skip_rain', 'skip_saturated',
]);

function getPhase(settings: any) {
  const seedDate = new Date(settings.seed_date + 'T00:00:00');
  const daysSince = Math.floor((Date.now() - seedDate.getTime()) / (24 * 3600 * 1000));
  let phase = 3;
  if (daysSince < settings.phase1_end_day) phase = 1;
  else if (daysSince < settings.phase2_end_day) phase = 2;
  return { daysSince: Math.max(daysSince, 0), phase };
}

function sumHourly(weather: any, hours: number) {
  const times: string[] = weather.hourly.time;
  const precip: number[] = weather.hourly.precipitation;
  const now = Date.now();
  let nowIdx = times.length - 1;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]).getTime() > now) { nowIdx = i - 1; break; }
  }
  let sum = 0;
  for (let i = Math.max(0, nowIdx - hours + 1); i <= nowIdx; i++) sum += precip[i] || 0;
  return sum;
}

function sumDailyTrailing(weather: any, days: number) {
  const vals: number[] = weather.daily.precipitation_sum;
  const slice = vals.slice(Math.max(0, vals.length - days));
  return slice.reduce((a, b) => a + (b || 0), 0);
}

function sumLogs(logs: any[], hours: number) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  return logs.filter(l => new Date(l.created_at).getTime() >= cutoff).reduce((a, l) => a + l.amount_inches, 0);
}

function computeMetrics(weather: any, logs: any[]) {
  const rain8h = sumHourly(weather, MOISTURE_LOOKBACK_HOURS);
  const rain24h = sumHourly(weather, 24);
  const rain48h = sumHourly(weather, 48);
  const rainWeek = sumDailyTrailing(weather, 7);
  const forecastToday = weather.daily.precipitation_sum[weather.daily.precipitation_sum.length - 1] || 0;

  return {
    forecastToday,
    combined8h: rain8h + sumLogs(logs, 8),
    combined24h: rain24h + sumLogs(logs, 24),
    combined48h: rain48h + sumLogs(logs, 48),
    combinedWeek: rainWeek + sumLogs(logs, 24 * 7),
  };
}

function computeStatus(settings: any, phaseInfo: any, metrics: any) {
  const { phase } = phaseInfo;

  if (metrics.forecastToday > RAIN_FORECAST_THRESHOLD) {
    return { key: 'skip_rain', detail: `${metrics.forecastToday.toFixed(2)}" of rain forecasted today.` };
  }

  if (phase === 1) {
    if (metrics.combined8h >= MOISTURE_LOOKBACK_THRESHOLD) {
      return { key: 'skip_moist', detail: `${metrics.combined8h.toFixed(2)}" of moisture in the last ${MOISTURE_LOOKBACK_HOURS}h.` };
    }
    return { key: 'water_now_mist', detail: 'Keep the top ½" of soil moist — short 5–10 min mist.' };
  }

  if (metrics.combined48h > SATURATION_48H_THRESHOLD) {
    const skipHours = metrics.combined48h > 1.0 ? 48 : 24;
    return { key: 'skip_saturated', detail: `${metrics.combined48h.toFixed(2)}" received in the last 48h. Re-check in ${skipHours}h.` };
  }

  if (phase === 2) {
    const dailyTarget = settings.root_dev_weekly_inches / 7;
    if (metrics.combined24h >= dailyTarget) {
      return { key: 'on_track_today', detail: `${metrics.combined24h.toFixed(2)}" today (target ${dailyTarget.toFixed(2)}").` };
    }
    return { key: 'water_now_deep', detail: `${metrics.combined24h.toFixed(2)}" today so far — target ${dailyTarget.toFixed(2)}", one deeper session.` };
  }

  if (metrics.combinedWeek >= settings.weekly_target_inches) {
    return { key: 'on_track_week', detail: `${metrics.combinedWeek.toFixed(2)}" of ${settings.weekly_target_inches}" this week.` };
  }
  const deficit = settings.weekly_target_inches - metrics.combinedWeek;
  return { key: 'water_now_weekly', detail: `${deficit.toFixed(2)}" still needed this week (${metrics.combinedWeek.toFixed(2)}" / ${settings.weekly_target_inches}").` };
}

function phaseName(phase: number) {
  return phase === 1 ? 'Germination' : phase === 2 ? 'Root Development' : 'Establishment';
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const slot = url.searchParams.get('slot') || 'morning';

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: settings, error: settingsErr } = await supabase
      .from('lawn_settings').select('*').eq('id', 1).maybeSingle();
    if (settingsErr || !settings) {
      return Response.json({ ok: false, reason: 'no lawn_settings row configured' }, { status: 200 });
    }

    const phaseInfo = getPhase(settings);

    // Root Development / Establishment only need one check per day.
    if (phaseInfo.phase !== 1 && slot !== 'morning') {
      return Response.json({ ok: true, skipped: true, reason: `phase ${phaseInfo.phase} only evaluates on the morning slot`, slot });
    }

    const since = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const { data: logs } = await supabase.from('water_logs').select('*').gte('created_at', since);

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${settings.latitude}&longitude=${settings.longitude}&hourly=precipitation&daily=precipitation_sum&past_days=7&forecast_days=1&timezone=auto`;
    const weatherRes = await fetch(weatherUrl);
    const weather = await weatherRes.json();

    const metrics = computeMetrics(weather, logs || []);
    const status = computeStatus(settings, phaseInfo, metrics);

    if (!NOTIFIABLE_KEYS.has(status.key)) {
      return Response.json({ ok: true, sent: false, reason: 'status not actionable', status: status.key });
    }

    const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('alert_history')
      .select('id')
      .eq('status_key', status.key)
      .gte('sent_at', dedupeSince)
      .limit(1);
    if (recent && recent.length > 0) {
      return Response.json({ ok: true, sent: false, reason: 'deduped — same status sent recently', status: status.key });
    }

    if (!settings.alert_email) {
      return Response.json({ ok: true, sent: false, reason: 'no alert_email configured' });
    }

    const meta = STATUS_META[status.key];
    const subject = `${meta.emoji} ${meta.label} — Day ${phaseInfo.daysSince} (${phaseName(phaseInfo.phase)})`;
    const html = `<p><strong>${meta.emoji} ${meta.label}</strong></p><p>${status.detail}</p><p style="color:#64748b;font-size:13px">Day ${phaseInfo.daysSince} of establishment · ${phaseName(phaseInfo.phase)} phase</p>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: Deno.env.get('RESEND_FROM_EMAIL') || 'Lawn Watering Assistant <onboarding@resend.dev>',
        to: settings.alert_email,
        subject,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return Response.json({ ok: false, reason: 'resend send failed', detail: errText }, { status: 200 });
    }

    await supabase.from('alert_history').insert({
      phase: phaseName(phaseInfo.phase),
      status_key: status.key,
      status_text: `${meta.label} — ${status.detail}`,
    });

    return Response.json({ ok: true, sent: true, status: status.key });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});

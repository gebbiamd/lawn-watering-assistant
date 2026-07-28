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
const RAIN_PROBABILITY_GATE_PCT = 40;
const MOISTURE_LOOKBACK_HOURS = 8;
const MOISTURE_LOOKBACK_THRESHOLD = 0.05;
const DEDUPE_WINDOW_HOURS = 4;
const URGENCY_SOON_PCT = 20;

// Prolonged nighttime leaf wetness is the single biggest driver of turf fungal
// disease (brown patch, dollar spot, pythium) — NC State/Purdue extension work
// puts the infection threshold at 10-12+ continuous wet hours, and watering
// after ~6pm roughly doubles the overnight wet window. 6-10am is the standard
// recommended window.
const WATERING_WINDOW_START_HOUR = 6;  // 6:00 AM
const QUIET_HOURS_START_HOUR = 20;     // 8:00 PM

const STATUS_META: Record<string, { emoji: string; label: string }> = {
  skip_rain:          { emoji: '🔵', label: 'SKIP - RAIN FORECASTED' },
  skip_saturated:     { emoji: '🔵', label: 'SKIP WATERING' },
  hold_until_morning: { emoji: '🌙', label: 'Hold Until Morning' },
  water_now_critical: { emoji: '🔴', label: 'Critically Dry — Water Now' },
  water_now:          { emoji: '🟠', label: 'Water Now' },
  water_soon:         { emoji: '🟡', label: 'Water Soon' },
  on_track:           { emoji: '🟢', label: 'On Track' },
};
const NOTIFIABLE_KEYS = new Set([
  'water_now_critical', 'water_now', 'water_soon', 'hold_until_morning', 'skip_rain', 'skip_saturated',
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
  const forecastProbability = weather.daily.precipitation_probability_max?.[weather.daily.precipitation_probability_max.length - 1] ?? 100;

  return {
    forecastToday,
    forecastProbability,
    combined8h: rain8h + sumLogs(logs, 8),
    combined24h: rain24h + sumLogs(logs, 24),
    combined48h: rain48h + sumLogs(logs, 48),
    combinedWeek: rainWeek + sumLogs(logs, 24 * 7),
  };
}

function computeMoistureLevel(schedule: { lastWetAt: Date | null; intervalHours: number }) {
  if (!schedule.lastWetAt) return { pct: 0, overdueHours: schedule.intervalHours };
  const elapsedHours = (Date.now() - schedule.lastWetAt.getTime()) / 3600000;
  const pct = Math.max(0, Math.min(100, 100 - (elapsedHours / schedule.intervalHours) * 100));
  const overdueHours = Math.max(0, elapsedHours - schedule.intervalHours);
  return { pct, overdueHours };
}

// Urgency (water_now / water_soon / on_track) comes from the same pct/overdue
// signal the app's moisture gauge uses, so the emailed status can never say
// "skip" for a routine near-due check — that word is reserved for the two
// genuine over-hydration cases (rain forecast, 48h saturation).
function computeStatus(settings: any, phaseInfo: any, metrics: any, schedule: any, tz: string) {
  const { phase } = phaseInfo;

  if (metrics.forecastToday > RAIN_FORECAST_THRESHOLD && metrics.forecastProbability >= RAIN_PROBABILITY_GATE_PCT) {
    return { key: 'skip_rain', detail: `${metrics.forecastToday.toFixed(2)}" of rain forecasted today (${Math.round(metrics.forecastProbability)}% chance).` };
  }
  if (metrics.combined48h > SATURATION_48H_THRESHOLD) {
    const skipHours = metrics.combined48h > 1.0 ? 48 : 24;
    return { key: 'skip_saturated', detail: `${metrics.combined48h.toFixed(2)}" received in the last 48h. Re-check in ${skipHours}h.` };
  }

  const { pct, overdueHours } = computeMoistureLevel(schedule);
  const urgency = overdueHours > 0
    ? (overdueHours > schedule.intervalHours * 0.5 ? 'critical' : 'now')
    : (pct < URGENCY_SOON_PCT ? 'soon' : 'ok');

  // Root Development / Establishment do a real deep soak — the kind that keeps
  // blades wet for hours. Germination's misting is brief and dries fast, and
  // delaying it risks the seed itself, so it's exempt from this rule.
  if (phase !== 1 && (urgency === 'critical' || urgency === 'now') && isQuietHour(new Date(), tz)) {
    return { key: 'hold_until_morning', detail: `Soil needs water, but watering overnight extends leaf wetness and raises disease risk. Water first thing at ${formatNextDue(schedule.recommendedAt, tz)}.` };
  }

  if (phase === 1) {
    if (urgency === 'critical' || urgency === 'now') {
      return { key: urgency === 'critical' ? 'water_now_critical' : 'water_now', detail: 'Keep the top ½" of soil moist — short 5–10 min mist now.' };
    }
    if (urgency === 'soon') {
      return { key: 'water_soon', detail: 'Top layer is starting to dry.' };
    }
    return { key: 'on_track', detail: `Soil moist — ${metrics.combined8h.toFixed(2)}" in the last ${MOISTURE_LOOKBACK_HOURS}h.` };
  }

  if (phase === 2) {
    const dailyTarget = settings.root_dev_weekly_inches / 7;
    if (urgency === 'critical' || urgency === 'now') {
      return { key: urgency === 'critical' ? 'water_now_critical' : 'water_now', detail: `${metrics.combined24h.toFixed(2)}" today so far — target ${dailyTarget.toFixed(2)}", time for a deeper session.` };
    }
    if (urgency === 'soon') {
      return { key: 'water_soon', detail: "Approaching today's watering window." };
    }
    return { key: 'on_track', detail: `${metrics.combined24h.toFixed(2)}" today so far — on pace for ${settings.root_dev_weekly_inches}"/wk.` };
  }

  const deficit = Math.max(0, settings.weekly_target_inches - metrics.combinedWeek);
  if (urgency === 'critical' || urgency === 'now') {
    return { key: urgency === 'critical' ? 'water_now_critical' : 'water_now', detail: `${deficit.toFixed(2)}" still needed this week (${metrics.combinedWeek.toFixed(2)}" / ${settings.weekly_target_inches}").` };
  }
  if (urgency === 'soon') {
    return { key: 'water_soon', detail: "Approaching this week's watering window." };
  }
  return { key: 'on_track', detail: `${metrics.combinedWeek.toFixed(2)}" of ${settings.weekly_target_inches}" this week.` };
}

function computeLastWetAt(weather: any, logs: any[]) {
  const times: string[] = weather.hourly.time;
  const precip: number[] = weather.hourly.precipitation;
  const now = Date.now();
  let lastRain: number | null = null;
  for (let i = times.length - 1; i >= 0; i--) {
    const t = new Date(times[i]).getTime();
    if (t > now) continue;
    if ((precip[i] || 0) >= 0.01) { lastRain = t; break; }
  }
  const lastLog = logs.length ? new Date(logs[0].created_at).getTime() : null;
  const candidates = [lastRain, lastLog].filter((v): v is number => v !== null);
  return candidates.length ? new Date(Math.max(...candidates)) : null;
}

function computeSchedule(settings: any, phaseInfo: any, weather: any, logs: any[], tz: string) {
  const lastWetAt = computeLastWetAt(weather, logs);
  let intervalHours: number, sessionAmountInches: number;

  if (phaseInfo.phase === 1) {
    intervalHours = 24 / settings.germination_sessions_per_day;
    sessionAmountInches = MOISTURE_LOOKBACK_THRESHOLD;
  } else if (phaseInfo.phase === 2) {
    const span = Math.max(1, settings.phase2_end_day - settings.phase1_end_day);
    const t = Math.min(1, Math.max(0, (phaseInfo.daysSince - settings.phase1_end_day) / span));
    const startHours = 24;
    const endHours = settings.establishment_interval_days * 24;
    intervalHours = startHours + t * (endHours - startHours);
    sessionAmountInches = settings.root_dev_weekly_inches * (intervalHours / 168);
  } else {
    intervalHours = settings.establishment_interval_days * 24;
    sessionAmountInches = settings.weekly_target_inches * (intervalHours / 168);
  }

  const nextDueAt = lastWetAt
    ? new Date(lastWetAt.getTime() + intervalHours * 3600 * 1000)
    : new Date();
  const recommendedAt = applyWateringWindow(nextDueAt, phaseInfo.phase, tz);
  return { intervalHours, sessionAmountInches, lastWetAt, nextDueAt, recommendedAt };
}

// How far tz's local wall clock is ahead of UTC, in minutes, at `date`.
function tzOffsetMinutes(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function localHour(date: Date, tz: string) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date), 10);
}

function isQuietHour(date: Date, tz: string) {
  const h = localHour(date, tz);
  return h >= QUIET_HOURS_START_HOUR || h < WATERING_WINDOW_START_HOUR;
}

// Builds a UTC Date instant for `hour`:00 local time (in tz) on the same local
// calendar day as `from`, using tz's offset at that moment.
function localTimeOnDate(from: Date, tz: string, hour: number, minute: number) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(from)) parts[p.type] = p.value;
  const offsetMin = tzOffsetMinutes(from, tz);
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, minute, 0) - offsetMin * 60000);
}

function nextWindowStart(from: Date, tz: string) {
  let candidate = localTimeOnDate(from, tz, WATERING_WINDOW_START_HOUR, 0);
  if (candidate <= from) candidate = new Date(candidate.getTime() + 24 * 3600 * 1000);
  return candidate;
}

// Nudges a *predicted* watering time away from the overnight disease-risk
// window. Germination is exempt when the session is already due/overdue —
// a few hours without moisture risks the seed itself, which outweighs the
// (much lower) disease risk from a brief, quick-drying mist.
function applyWateringWindow(dueAt: Date, phase: number, tz: string) {
  if (phase === 1) {
    if (dueAt <= new Date()) return dueAt;
    const h = localHour(dueAt, tz);
    if (h >= 22 || h < 5) {
      let snapped = localTimeOnDate(dueAt, tz, 5, 30);
      if (snapped < dueAt) snapped = new Date(snapped.getTime() + 24 * 3600 * 1000);
      return snapped;
    }
    return dueAt;
  }
  return isQuietHour(dueAt, tz) ? nextWindowStart(dueAt, tz) : dueAt;
}

function formatDuration(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h${m ? ' ' + m + 'm' : ''}`;
}

// tz is the lawn's own IANA timezone (from Open-Meteo's timezone=auto response) —
// the Edge Runtime itself runs in UTC, so times must be rendered in tz explicitly
// or the email would show the wrong local time.
function formatNextDue(date: Date, tz: string) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs <= 0) {
    return `overdue by ${formatDuration(Math.abs(diffMs) / 3600000)}`;
  }

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  const dayFmt = (d: Date) => d.toLocaleDateString('en-US', { timeZone: tz });
  const diffDays = Math.round((new Date(dayFmt(date)).getTime() - new Date(dayFmt(now)).getTime()) / 86400000);

  let dayLabel: string;
  if (diffDays === 0) dayLabel = 'Today';
  else if (diffDays === 1) dayLabel = 'Tomorrow';
  else if (diffDays <= 6) dayLabel = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  else dayLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });

  if (diffMs < 36 * 3600 * 1000) {
    return `${dayLabel} at ${timeStr} (in ${formatDuration(diffMs / 3600000)})`;
  }
  return `${dayLabel} at ${timeStr}`;
}

function formatAmount(inches: number, ratePerHour: number) {
  const rate = ratePerHour || 0.5;
  const mins = Math.max(1, Math.round((inches / rate) * 60));
  return `${inches.toFixed(2)}" (≈${mins} min)`;
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

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${settings.latitude}&longitude=${settings.longitude}&hourly=precipitation&daily=precipitation_sum,precipitation_probability_max&precipitation_unit=inch&past_days=7&forecast_days=1&timezone=auto`;
    const weatherRes = await fetch(weatherUrl);
    const weather = await weatherRes.json();

    const tz = weather.timezone || 'UTC';
    const metrics = computeMetrics(weather, logs || []);
    const schedule = computeSchedule(settings, phaseInfo, weather, logs || [], tz);
    const status = computeStatus(settings, phaseInfo, metrics, schedule, tz);

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
    const nextDueText = `Next watering: ${formatNextDue(schedule.recommendedAt, tz)} — ${formatAmount(schedule.sessionAmountInches, settings.sprinkler_rate_inches_per_hour)}`;
    const subject = `${meta.emoji} ${meta.label} — Day ${phaseInfo.daysSince} (${phaseName(phaseInfo.phase)})`;
    const html = `<p><strong>${meta.emoji} ${meta.label}</strong></p><p>${status.detail}</p><p>${nextDueText}</p><p style="color:#64748b;font-size:13px">Day ${phaseInfo.daysSince} of establishment · ${phaseName(phaseInfo.phase)} phase</p>`;

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
      status_text: `${meta.label} — ${status.detail} ${nextDueText}.`,
    });

    return Response.json({ ok: true, sent: true, status: status.key });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});

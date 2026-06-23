import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';

const app = new Hono();

const VALID_RANGES = ['7d', '30d', '90d', 'all'] as const;
type Range = typeof VALID_RANGES[number];

// Dashboard overview stats for a given time range (e.g. ?range=7d|30d|90d|all)
app.get('/dashboard', (c) => {
  const db = getDb();
  const { range = '7d' } = c.req.query();

  if (!VALID_RANGES.includes(range as Range)) {
    return c.json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` }, 400);
  }

  let periodStart: string | null = null;
  const now = new Date();
  if (range === '7d') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (range === '30d') {
    periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  } else if (range === '90d') {
    periodStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  const where = periodStart
    ? 'WHERE started_at >= ? AND deleted_at IS NULL'
    : 'WHERE deleted_at IS NULL';
  const params = periodStart ? [periodStart] : [];

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS session_count,
      COUNT(DISTINCT project_id) AS active_projects,
      SUM(message_count) AS total_messages,
      SUM(tool_call_count) AS total_tool_calls,
      CAST(COALESCE(SUM(
        CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(ended_at) - julianday(started_at)) * 1440
          ELSE 0
        END
      ), 0) AS INTEGER) AS total_duration_min,
      SUM(total_input_tokens) AS total_input_tokens,
      SUM(total_output_tokens) AS total_output_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(estimated_cost_usd) AS estimated_cost_usd
    FROM sessions ${where}
  `).get(...params);

  return c.json({ range, stats });
});

// Cognitive-load model: a human turn keeps its session "warm" for ATTENTION_MIN
// minutes. While warm, the session contributes to concurrent multitasking. Load
// at any minute = (concurrent warm sessions) × (concurrent warm projects)² — the
// projects term is squared so juggling across multiple projects compounds far
// faster than stacking sessions within one project. Daily load integrates that
// over the day's active minutes (1-minute resolution). Truly idle sessions emit
// no human turns, so they go cold and add nothing — matching the intuition that
// a long unattended session is cheap, but rapid switching is expensive.
const ATTENTION_MIN = 15;
const MS_PER_MIN = 60_000;

interface CognitiveDay {
  cognitive_load: number; // Σ (sessions × projects²) over active minutes
  peak_sessions: number;  // max concurrent warm sessions in any minute
  peak_projects: number;  // max concurrent warm projects in any minute
}

function computeCognitiveLoad(db: ReturnType<typeof getDb>): Map<string, CognitiveDay> {
  // Genuine human turns only: type='user' AND non-empty content. (type='user'
  // with empty content is an automated tool-result message, not a human pulse.)
  const pulses = db.prepare(`
    SELECT m.timestamp AS t, m.session_id AS sid, s.project_id AS pid
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.type = 'user' AND m.content <> '' AND s.deleted_at IS NULL
    ORDER BY m.timestamp
  `).all() as Array<{ t: string; sid: string; pid: string }>;

  // Spread each pulse across the warm window into 1-minute buckets, tracking the
  // distinct sessions and projects live in each minute.
  const buckets = new Map<number, { sessions: Set<string>; projects: Set<string> }>();
  for (const p of pulses) {
    const startMin = Math.floor(new Date(p.t).getTime() / MS_PER_MIN);
    for (let k = 0; k < ATTENTION_MIN; k++) {
      const mi = startMin + k;
      let b = buckets.get(mi);
      if (!b) { b = { sessions: new Set(), projects: new Set() }; buckets.set(mi, b); }
      b.sessions.add(p.sid);
      b.projects.add(p.pid);
    }
  }

  const byDate = new Map<string, CognitiveDay>();
  for (const [mi, b] of buckets) {
    const date = new Date(mi * MS_PER_MIN).toISOString().slice(0, 10);
    const s = b.sessions.size;
    const pr = b.projects.size;
    const d = byDate.get(date) ?? { cognitive_load: 0, peak_sessions: 0, peak_projects: 0 };
    d.cognitive_load += s * pr * pr;
    if (s > d.peak_sessions) d.peak_sessions = s;
    if (pr > d.peak_projects) d.peak_projects = pr;
    byDate.set(date, d);
  }
  return byDate;
}

// Per-day activity series (all-time, gap-filled) for the Activity chart.
// One row per calendar day from the first recorded session to the last, with
// zero-filled gaps so the timeline has no holes. Metric definitions match the
// CLI dashboard: tokens = input+output+cache_creation+cache_read.
app.get('/activity', (c) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT substr(started_at, 1, 10) AS date,
           COUNT(*) AS sessions,
           COUNT(DISTINCT project_id) AS projects,
           COALESCE(SUM(message_count), 0) AS messages,
           COALESCE(SUM(tool_call_count), 0) AS tool_calls,
           COALESCE(SUM(
             COALESCE(total_input_tokens, 0) + COALESCE(total_output_tokens, 0)
             + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)
           ), 0) AS tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS cost
    FROM sessions
    WHERE deleted_at IS NULL AND started_at IS NOT NULL AND started_at <> ''
    GROUP BY date
    ORDER BY date
  `).all() as Array<{
    date: string;
    sessions: number;
    projects: number;
    messages: number;
    tool_calls: number;
    tokens: number;
    cost: number;
  }>;

  if (rows.length === 0) return c.json({ days: [] });

  const cognitive = computeCognitiveLoad(db);
  const zeroCog: CognitiveDay = { cognitive_load: 0, peak_sessions: 0, peak_projects: 0 };

  // Gap-fill every calendar day between the first and last recorded day.
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const days = [];
  const oneDay = 86_400_000;
  const start = new Date(`${rows[0].date}T00:00:00Z`).getTime();
  const end = new Date(`${rows[rows.length - 1].date}T00:00:00Z`).getTime();
  for (let t = start; t <= end; t += oneDay) {
    const date = new Date(t).toISOString().slice(0, 10);
    const r = byDate.get(date);
    const cog = cognitive.get(date) ?? zeroCog;
    days.push(
      r
        ? { ...r, tokens: Math.round(r.tokens), cost: Math.round(r.cost * 100) / 100, ...cog }
        : { date, sessions: 0, projects: 0, messages: 0, tool_calls: 0, tokens: 0, cost: 0, ...cog }
    );
  }

  return c.json({ days });
});

// Global cumulative usage stats
app.get('/usage', (c) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT total_input_tokens, total_output_tokens, cache_creation_tokens,
           cache_read_tokens, estimated_cost_usd, sessions_with_usage, last_updated_at
    FROM usage_stats WHERE id = 1
  `).get();
  return c.json({ stats: stats ?? null });
});

export default app;

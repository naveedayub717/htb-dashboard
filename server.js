'use strict';
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: (process.env.DATABASE_URL || '').includes('localhost') ? false : { rejectUnauthorized: false },
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema ready');
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Unauthorized' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0]?.value || null;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
    [key, value]
  );
}

function fv(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function parseDur(iso) {
  let h = 0, m = 0, s = 0;
  const hm = iso.match(/(\d+)H/); if (hm) h = parseInt(hm[1]);
  const mm = iso.match(/(\d+)M/); if (mm) m = parseInt(mm[1]);
  const sm = iso.match(/(\d+)S/); if (sm) s = parseInt(sm[1]);
  return h * 3600 + m * 60 + s;
}

async function apiFetch(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
      [email.toLowerCase().trim(), hash]
    );
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: rows[0].email });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email?.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: rows[0].email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Data ──────────────────────────────────────────────────────────────────────

app.get('/api/data', auth, async (req, res) => {
  try {
    const [posts, videos, fmts, igManual, ytFmts, hooks, settings] = await Promise.all([
      pool.query('SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'),
      pool.query('SELECT id, caption, thumb, ts, views, likes, comments, duration, vtype, outlier_mult AS "outlierMult", plat FROM yt_videos ORDER BY ts DESC'),
      pool.query('SELECT pid, status, format, views, links, added FROM formats ORDER BY added'),
      pool.query('SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM ig_manual_formats ORDER BY added'),
      pool.query('SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM yt_formats ORDER BY added'),
      pool.query('SELECT id, text, status, note, link, added FROM hooks ORDER BY added'),
      pool.query('SELECT key, value FROM app_settings'),
    ]);

    const settingsMap = {};
    settings.rows.forEach(r => { settingsMap[r.key] = r.value; });

    res.json({
      igPosts: posts.rows,
      ytVideos: videos.rows,
      formats: fmts.rows,
      igManualFormats: igManual.rows,
      ytFormats: ytFmts.rows,
      hooks: hooks.rows,
      hasIGToken: !!settingsMap.ig_token,
      hasYTKey: !!settingsMap.yt_key,
      manualAvg: parseInt(settingsMap.manual_avg || '0') || 0,
      igWeekTarget: parseInt(settingsMap.ig_week_target || '0') || 0,
      igMonthTarget: parseInt(settingsMap.ig_month_target || '0') || 0,
      ytWeekTarget: parseInt(settingsMap.yt_week_target || '0') || 0,
      ytMonthTarget: parseInt(settingsMap.yt_month_target || '0') || 0,
      wflinks: settingsMap.wflinks ? JSON.parse(settingsMap.wflinks) : {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.put('/api/settings', auth, async (req, res) => {
  try {
    const { igToken, ytKey, anthropicKey, manualAvg, igWeekTarget, igMonthTarget, ytWeekTarget, ytMonthTarget } = req.body;
    if (igToken !== undefined) await setSetting('ig_token', igToken);
    if (ytKey !== undefined) await setSetting('yt_key', ytKey);
    if (anthropicKey !== undefined) await setSetting('anthropic_key', anthropicKey);
    if (manualAvg !== undefined) await setSetting('manual_avg', String(manualAvg));
    if (igWeekTarget !== undefined) await setSetting('ig_week_target', String(igWeekTarget));
    if (igMonthTarget !== undefined) await setSetting('ig_month_target', String(igMonthTarget));
    if (ytWeekTarget !== undefined) await setSetting('yt_week_target', String(ytWeekTarget));
    if (ytMonthTarget !== undefined) await setSetting('yt_month_target', String(ytMonthTarget));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings/wflinks', auth, async (req, res) => {
  try {
    await setSetting('wflinks', JSON.stringify(req.body));
    broadcast({ type: 'wflinks', data: req.body });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Instagram sync ────────────────────────────────────────────────────────────

app.post('/api/ig/sync', auth, async (req, res) => {
  try {
    const token = await getSetting('ig_token');
    if (!token) return res.status(400).json({ error: 'No Instagram token configured. Add it in Settings first.' });

    const me = await apiFetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);

    const { rows: existing } = await pool.query('SELECT id, views, format, f_status FROM ig_posts');
    const ex = {};
    existing.forEach(p => { ex[p.id] = p; });

    let all = [];
    let url = `https://graph.instagram.com/${me.id}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,video_views,permalink&limit=50&access_token=${token}`;

    while (url && all.length < 600) {
      const data = await apiFetch(url);
      const batch = (data.data || []).filter(p => p.media_type === 'VIDEO' || p.media_type === 'REEL');
      batch.forEach(p => {
        const apiViews = p.video_views || 0;
        const existingViews = ex[p.id]?.views || 0;
        all.push({
          id: p.id,
          caption: p.caption || '',
          thumb: p.thumbnail_url || p.media_url || '',
          ts: p.timestamp,
          views: apiViews > 0 ? apiViews : existingViews,
          likes: p.like_count || 0,
          comments: p.comments_count || 0,
          format: ex[p.id]?.format || null,
          f_status: ex[p.id]?.f_status || null,
          permalink: p.permalink || '',
        });
      });
      url = data.paging?.next || null;
    }

    for (const p of all) {
      await pool.query(
        `INSERT INTO ig_posts (id, caption, thumb, ts, views, likes, comments, format, f_status, plat, permalink)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ig',$10)
         ON CONFLICT (id) DO UPDATE SET caption=$2, thumb=$3, ts=$4,
           views = CASE WHEN $5 > 0 THEN $5 ELSE ig_posts.views END,
           likes=$6, comments=$7, permalink=$10`,
        [p.id, p.caption, p.thumb, p.ts, p.views, p.likes, p.comments, p.format ? JSON.stringify(p.format) : null, p.f_status, p.permalink]
      );
    }

    const { rows: updated } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'
    );
    broadcast({ type: 'igPosts', data: updated });
    res.json({ posts: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube sync ──────────────────────────────────────────────────────────────

app.post('/api/yt/sync', auth, async (req, res) => {
  try {
    const ytKey = await getSetting('yt_key');
    if (!ytKey) return res.status(400).json({ error: 'No YouTube API key configured. Add it in Settings first.' });

    const YT_HANDLE = 'hakeemhoang';
    const chanRes = await apiFetch(`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails,statistics&forHandle=${YT_HANDLE}&key=${ytKey}`);
    if (!chanRes.items?.length) throw new Error('Channel not found. Check your API key.');
    const uploadsId = chanRes.items[0].contentDetails.relatedPlaylists.uploads;

    let all = [];
    let pageToken = '';
    let pages = 0;

    while (pages < 20) {
      const ptParam = pageToken ? `&pageToken=${pageToken}` : '';
      const plRes = await apiFetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=50&key=${ytKey}${ptParam}`);
      const items = plRes.items || [];
      const vidIds = items.map(it => it.snippet.resourceId.videoId).join(',');
      if (!vidIds) break;

      const statsRes = await apiFetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${vidIds}&key=${ytKey}`);
      const sm = {};
      (statsRes.items || []).forEach(v => { sm[v.id] = v; });

      items.forEach(it => {
        const vid = sm[it.snippet.resourceId.videoId];
        if (!vid) return;
        const dur = parseDur(vid.contentDetails?.duration || 'PT0S');
        all.push({
          id: vid.id,
          caption: vid.snippet.title || '',
          thumb: vid.snippet.thumbnails?.medium?.url || '',
          ts: vid.snippet.publishedAt,
          views: parseInt(vid.statistics.viewCount || 0),
          likes: parseInt(vid.statistics.likeCount || 0),
          comments: parseInt(vid.statistics.commentCount || 0),
          duration: dur,
          vtype: dur >= 180 ? 'long' : 'short',
        });
      });

      pageToken = plRes.nextPageToken || '';
      pages++;
      if (!pageToken) break;
    }

    for (const v of all) {
      await pool.query(
        `INSERT INTO yt_videos (id, caption, thumb, ts, views, likes, comments, duration, vtype, plat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'yt')
         ON CONFLICT (id) DO UPDATE SET caption=$2, thumb=$3, ts=$4, views=$5, likes=$6, comments=$7, duration=$8, vtype=$9`,
        [v.id, v.caption, v.thumb, v.ts, v.views, v.likes, v.comments, v.duration, v.vtype]
      );
    }

    const { rows: updated } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, duration, vtype, outlier_mult AS "outlierMult", plat FROM yt_videos ORDER BY ts DESC'
    );
    broadcast({ type: 'ytVideos', data: updated });
    res.json({ videos: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Post views ────────────────────────────────────────────────────────────────

app.put('/api/ig-posts/:id/views', auth, async (req, res) => {
  try {
    const { views } = req.body;
    await pool.query('UPDATE ig_posts SET views=$1 WHERE id=$2', [views, req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'
    );
    broadcast({ type: 'igPosts', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI: Analyze format ────────────────────────────────────────────────────────

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const { postId, content } = req.body;
    const ak = await getSetting('anthropic_key');
    if (!ak) return res.status(400).json({ error: 'No Anthropic API key configured. Add it in Settings first.' });

    const { rows } = await pool.query('SELECT * FROM ig_posts WHERE id=$1', [postId]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const manualAvg = parseInt((await getSetting('manual_avg')) || '0') || 0;
    const { rows: viewRows } = await pool.query('SELECT views FROM ig_posts WHERE views > 0');
    const igAvg = manualAvg || (viewRows.length
      ? Math.round(viewRows.reduce((a, p) => a + p.views, 0) / viewRows.length)
      : 20000);
    const mx = igAvg ? Math.round((post.views / igAvg) * 10) / 10 : 0;

    const prompt = `You are the content strategist for Hakeem Hoang (@hakeemhoang), founder of High Ticket Barbers (HTB).

This Instagram video got ${fv(post.views)} views which is ${mx}x above his channel average.

HTB helps barbers build premium personal brands. Hakeems voice: grade 5 English, no jargon, spoken language.

THREE KNOWN WINNING FORMATS:
1. ORIGIN STORY ARC: Hook with dollar contrast, shame detail, grind that did not work, turning point, climb with numbers, lesson with contrarian line.
2. TWO-BARBER COMPARISON SKIT: Split screen, left wrong barber, right correct barber, 4-5 contrast pairs escalating.
3. INTERVIEW FORMAT: Opens with money question, shocking numbers, escalating questions, divisive close.

VIDEO CONTENT:
"${content.substring(0, 2000)}"

Return ONLY valid JSON:
{"name":"Short format name 3-5 words","matchedFormat":"Origin Story Arc OR Two-Barber Comparison Skit OR Interview Format OR New Format","pillar":"HTB content pillar","hookType":"Specific hook type","whyItWorks":"One clear sentence","isNewFormat":true,"sections":[{"label":"HOOK","name":"What the hook does","description":"How this works","example":"Exact line from this video"},{"label":"BODY","name":"How the body builds","description":"Flow and escalation","example":"Specific moment"},{"label":"TURNING POINT","name":"The shift","description":"How it lands","example":"Exact moment"},{"label":"CLOSE","name":"How it ends","description":"The close","example":"Exact closing"}],"reusableTemplate":["Step 1","Step 2","Step 3","Step 4"]}`;

    const anthropic = new Anthropic({ apiKey: ak });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1400,
      messages: [{ role: 'user', content: prompt }],
    });

    const fmt = JSON.parse(message.content[0].text.replace(/```json|```/g, '').trim());

    await pool.query('UPDATE ig_posts SET format=$1 WHERE id=$2', [JSON.stringify(fmt), postId]);

    const { rows: updated } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'
    );
    broadcast({ type: 'igPosts', data: updated });
    res.json({ format: fmt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI: Generate script ───────────────────────────────────────────────────────

app.post('/api/generate-script', auth, async (req, res) => {
  try {
    const { formatName, formatType, steps, idea } = req.body;
    const ak = await getSetting('anthropic_key');
    if (!ak) return res.status(400).json({ error: 'No Anthropic API key configured. Add it in Settings first.' });

    const stepsText = steps.map((st, i) => `${i + 1}. ${st}`).join('\n');
    const prompt = `You are writing a script for Hakeem Hoang, founder of High Ticket Barbers (HTB).

VOICE: Grade 5 English. Short sentences. No jargon. Sounds like Hakeem talking to a barber friend.

POSITIONING: Stop being a barber. Become a brand. Skill does not set your price. Attention does.

PROOF: Joshy $6K to $17K in 4 months. Bryan $6K to $20K. Kevin 2K to 70K Instagram. Landen $40 cuts to $13K per month.

FORMAT: ${formatName} (${formatType})
STRUCTURE:
${stepsText}

IDEA:
"${idea}"

Write the full script broken into labeled sections matching the format structure. Use specific numbers. End with a clear CTA.`;

    const anthropic = new Anthropic({ apiKey: ak });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ script: message.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Formats library ───────────────────────────────────────────────────────────

app.post('/api/formats', auth, async (req, res) => {
  try {
    const { pid, status, format, views } = req.body;
    await pool.query(
      `INSERT INTO formats (pid, status, format, views, links, added)
       VALUES ($1,$2,$3,$4,'[]',NOW())
       ON CONFLICT (pid) DO UPDATE SET status=$2`,
      [pid, status, JSON.stringify(format), views]
    );
    await pool.query('UPDATE ig_posts SET f_status=$1 WHERE id=$2', [status, pid]);

    const [fmts, posts] = await Promise.all([
      pool.query('SELECT pid, status, format, views, links, added FROM formats ORDER BY added'),
      pool.query('SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'),
    ]);
    broadcast({ type: 'formats', data: fmts.rows });
    broadcast({ type: 'igPosts', data: posts.rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/formats/:pid', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE formats SET status=$1 WHERE pid=$2', [status, req.params.pid]);
    await pool.query('UPDATE ig_posts SET f_status=$1 WHERE id=$2', [status, req.params.pid]);

    const [fmts, posts] = await Promise.all([
      pool.query('SELECT pid, status, format, views, links, added FROM formats ORDER BY added'),
      pool.query('SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'),
    ]);
    broadcast({ type: 'formats', data: fmts.rows });
    broadcast({ type: 'igPosts', data: posts.rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/formats/:pid', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM formats WHERE pid=$1', [req.params.pid]);
    await pool.query('UPDATE ig_posts SET f_status=NULL WHERE id=$1', [req.params.pid]);

    const [fmts, posts] = await Promise.all([
      pool.query('SELECT pid, status, format, views, links, added FROM formats ORDER BY added'),
      pool.query('SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'),
    ]);
    broadcast({ type: 'formats', data: fmts.rows });
    broadcast({ type: 'igPosts', data: posts.rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/formats/:pid/links', auth, async (req, res) => {
  try {
    await pool.query('UPDATE formats SET links=$1 WHERE pid=$2', [JSON.stringify(req.body.links), req.params.pid]);
    const { rows } = await pool.query('SELECT pid, status, format, views, links, added FROM formats ORDER BY added');
    broadcast({ type: 'formats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── IG manual formats ─────────────────────────────────────────────────────────

app.post('/api/ig-manual-formats', auth, async (req, res) => {
  try {
    const { name, status, whyItWorks, steps, links } = req.body;
    await pool.query(
      'INSERT INTO ig_manual_formats (name, status, why_it_works, steps, links) VALUES ($1,$2,$3,$4,$5)',
      [name, status, whyItWorks, JSON.stringify(steps), JSON.stringify(links || [])]
    );
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM ig_manual_formats ORDER BY added'
    );
    broadcast({ type: 'igManualFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ig-manual-formats/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE ig_manual_formats SET status=$1 WHERE id=$2', [status, req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM ig_manual_formats ORDER BY added'
    );
    broadcast({ type: 'igManualFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ig-manual-formats/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ig_manual_formats WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM ig_manual_formats ORDER BY added'
    );
    broadcast({ type: 'igManualFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube formats ───────────────────────────────────────────────────────────

app.post('/api/yt-formats', auth, async (req, res) => {
  try {
    const { name, status, whyItWorks, steps, links } = req.body;
    await pool.query(
      'INSERT INTO yt_formats (name, status, why_it_works, steps, links) VALUES ($1,$2,$3,$4,$5)',
      [name, status, whyItWorks, JSON.stringify(steps), JSON.stringify(links || [])]
    );
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM yt_formats ORDER BY added'
    );
    broadcast({ type: 'ytFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/yt-formats/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE yt_formats SET status=$1 WHERE id=$2', [status, req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM yt_formats ORDER BY added'
    );
    broadcast({ type: 'ytFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/yt-formats/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM yt_formats WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, name, status, why_it_works AS "whyItWorks", steps, links, added FROM yt_formats ORDER BY added'
    );
    broadcast({ type: 'ytFormats', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Hooks ─────────────────────────────────────────────────────────────────────

app.post('/api/hooks', auth, async (req, res) => {
  try {
    const { text, status, note, link } = req.body;
    await pool.query(
      'INSERT INTO hooks (text, status, note, link) VALUES ($1,$2,$3,$4)',
      [text, status, note || '', link || '']
    );
    const { rows } = await pool.query('SELECT id, text, status, note, link, added FROM hooks ORDER BY added');
    broadcast({ type: 'hooks', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/hooks/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE hooks SET status=$1 WHERE id=$2', [status, req.params.id]);
    const { rows } = await pool.query('SELECT id, text, status, note, link, added FROM hooks ORDER BY added');
    broadcast({ type: 'hooks', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/hooks/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM hooks WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query('SELECT id, text, status, note, link, added FROM hooks ORDER BY added');
    broadcast({ type: 'hooks', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Outlier marking ───────────────────────────────────────────────────────────

app.put('/api/ig-posts/:id/outlier', auth, async (req, res) => {
  try {
    const { mult } = req.body;
    await pool.query('UPDATE ig_posts SET outlier_mult=$1 WHERE id=$2', [mult || null, req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, format, f_status AS "fStatus", outlier_mult AS "outlierMult", permalink, plat FROM ig_posts ORDER BY ts DESC'
    );
    broadcast({ type: 'igPosts', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/yt-videos/:id/outlier', auth, async (req, res) => {
  try {
    const { mult } = req.body;
    await pool.query('UPDATE yt_videos SET outlier_mult=$1 WHERE id=$2', [mult || null, req.params.id]);
    const { rows } = await pool.query(
      'SELECT id, caption, thumb, ts, views, likes, comments, duration, vtype, outlier_mult AS "outlierMult", plat FROM yt_videos ORDER BY ts DESC'
    );
    broadcast({ type: 'ytVideos', data: rows });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

app.get('/api/analytics', auth, async (req, res) => {
  try {
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const cutoff = months[0] + '-01';

    const [igRes, ytRes, ytViewsRes] = await Promise.all([
      pool.query(
        `SELECT TO_CHAR(DATE_TRUNC('month', ts), 'YYYY-MM') AS month, COUNT(*)::int AS count
         FROM ig_posts WHERE ts >= $1::date GROUP BY month`,
        [cutoff]
      ),
      pool.query(
        `SELECT TO_CHAR(DATE_TRUNC('month', ts), 'YYYY-MM') AS month, COUNT(*)::int AS count
         FROM yt_videos WHERE ts >= $1::date GROUP BY month`,
        [cutoff]
      ),
      pool.query(
        `SELECT TO_CHAR(DATE_TRUNC('month', ts), 'YYYY-MM') AS month, COALESCE(SUM(views),0)::int AS views
         FROM yt_videos WHERE ts >= $1::date AND duration > 180 GROUP BY month`,
        [cutoff]
      ),
    ]);

    const igMap = {}, ytMap = {}, ytViewsMap = {};
    igRes.rows.forEach(r => { igMap[r.month] = r.count; });
    ytRes.rows.forEach(r => { ytMap[r.month] = r.count; });
    ytViewsRes.rows.forEach(r => { ytViewsMap[r.month] = r.views; });

    const igOverrides = { '2026-01': 55, '2026-02': 67, '2026-03': 77, '2026-04': 82 };
    Object.assign(igMap, igOverrides);

    res.json({
      months,
      igCounts: months.map(m => igMap[m] || 0),
      ytCounts: months.map(m => ytMap[m] || 0),
      ytViews:  months.map(m => ytViewsMap[m] || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Serve SPA ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`HTB Dashboard listening on port ${PORT}`);
  if (!process.env.DATABASE_URL) {
    console.error('WARNING: DATABASE_URL is not set. DB calls will fail.');
    return;
  }
  initDB().catch(e => console.error('DB init failed:', e.message));
});

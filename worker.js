import { DISTRICTS } from './districts.js';

const CACHE_TTL = 1800; // 30 นาที

export default {
  // Cron ทุก 30 นาที - เขียนแค่ 1 ครั้ง!
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateAllDistricts(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public
    if (path === '/') {
      return json({ status: 'ok', version: '5.1-single-key-cache', total_districts: Object.keys(DISTRICTS).length });
    }
    if (path === '/api/districts') {
      return json(DISTRICTS);
    }

    // เช็ค Key สำหรับ API ที่เหลือ
    if (path.startsWith('/api/')) {
      const clientKey = request.headers.get('X-API-KEY');
      if (clientKey!== env.MOBILE_API_KEY) {
        return json({ error: 'Unauthorized' }, 401);
      }
    }

    // ---- ตู้เย็นหน้าบ้าน ----
    const cache = caches.default;
    let response = await cache.match(request);
    if (response) {
      return response; // ฟรี! ไม่นับ KV Read
    }

    // ไม่มีในตู้เย็น ค่อยไปเอาใน KV (นับ 1 Read)
    const allDataRaw = await env.WEATHER_KV.get('bangkok_all');
    if (!allDataRaw) {
      // ถ้า KV ยังว่าง (เพิ่ง deploy) ให้ไปดึงสดเลย 1 รอบ
      await updateAllDistricts(env);
      return json({ status: 'warming_up', message: 'Fetching 50 districts, try again in 30 sec' });
    }
    const allData = JSON.parse(allDataRaw);

    if (path === '/api/bangkok/all') {
      const days = parseInt(url.searchParams.get('days') || '3');
      // ตัดวันตามที่ขอมานิดหน่อยฝั่ง Worker เพื่อประหยัดเน็ตมือถือ
      const filtered = {};
      for (const k in allData) {
        filtered[k] = {
         ...allData[k],
          forecast: { forecastday: allData[k].forecast.forecastday.slice(0, days) }
        };
      }
      response = json(filtered);
    } else if (path === '/api/weather') {
      const district = url.searchParams.get('district');
      if (!district ||!allData[district]) {
        return json({ error: 'district not found' }, 404);
      }
      response = json(allData[district]);
    } else {
      return json({ error: 'not found' }, 404);
    }

    // เอาไปแช่ตู้เย็นหน้าบ้านไว้ 30 นาที
    response.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    ctx.waitUntil(cache.put(request, response.clone()));

    return response;
  }
}

async function updateAllDistricts(env) {
  const results = {};
  // ยิงทีเดียว 50 เขตแล้วรวมเป็นก้อนเดียว
  const promises = Object.entries(DISTRICTS).map(async ([key, d]) => {
    const apiUrl = `https://api.weatherapi.com/v1/forecast.json?key=${env.WEATHER_API_KEY}&q=${d.lat},${d.lon}&days=3&aqi=no&alerts=no`;
    const r = await fetch(apiUrl);
    const data = await r.json();
    results[key] = data;
  });
  await Promise.all(promises);

  // เขียนแค่ครั้งเดียว! 48 write/วัน
  await env.WEATHER_KV.put('bangkok_all', JSON.stringify(results), { expirationTtl: 3600 });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
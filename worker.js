/**
 * Weather Bangkok v5.3 - FIX total 0 issue
 * - import { DISTRICTS } แบบถูกต้อง
 * - ถ้า weatherapi ล้มบางเขต จะไม่ล้มทั้ง 50
 * - log error ชัดเจน
 */

import { DISTRICTS } from './districts.js';

async function fetchAllWeather(apiKey) {
  const results = [];
  let failed = 0;
  
  // ยิงทีละ 10 เขต ไม่ยิงพร้อมกัน 50 ทีเดียว เดี๋ยวโดน rate limit
  for (let i = 0; i < DISTRICTS.length; i += 10) {
    const chunk = DISTRICTS.slice(i, i + 10);
    const chunkResults = await Promise.all(
      chunk.map(async (d) => {
        try {
          const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${d.lat},${d.lon}&days=7&aqi=no&alerts=no`;
          const res = await fetch(url);
          if (!res.ok) {
            console.error(`Failed ${d.id}: ${res.status} ${await res.text()}`);
            failed++;
            return null;
          }
          const json = await res.json();
          return {
            id: d.id,
            name_th: d.name_th || d.name,
            name_en: d.name_en,
            lat: d.lat,
            lon: d.lon,
            current: json.current,
            forecast: json.forecast,
            location: json.location,
            updated_at: new Date().toISOString()
          };
        } catch (err) {
          console.error(`Error ${d.id}:`, err.message);
          failed++;
          return null;
        }
      })
    );
    results.push(...chunkResults.filter(Boolean));
  }
  
  return { results, failed, total: DISTRICTS.length };
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const apiKey = env.WEATHERAPI_KEY || env.WEATHER_API_KEY;
      if (!apiKey) throw new Error("Missing WEATHERAPI_KEY or WEATHER_API_KEY");

      console.log(`Starting fetch for ${DISTRICTS.length} districts`);
      const { results, failed, total } = await fetchAllWeather(apiKey);
      
      console.log(`Fetched ${results.length}/${total} success, ${failed} failed`);

      if (results.length === 0) {
        throw new Error(`All districts failed. Check WEATHER_API_KEY valid? Failed=${failed}`);
      }

      const payload = {
        status: "ok",
        version: "5.3-fixed",
        total_districts: results.length,
        failed: failed,
        updated_at: new Date().toISOString(),
        data: results
      };

      await env.WEATHER_KV.put("bangkok_all", JSON.stringify(payload));
      console.log(`Saved ${results.length} districts to KV`);

    } catch (e) {
      console.error("Cron error:", e.message, e.stack);
      // ไม่ throw ต่อ เพื่อไม่ให้ Cron retry รัวๆ
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-mobile-key",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // เช็ค MOBILE KEY
    if (url.pathname.startsWith("/api/")) {
      const mobileKeySecret = env.MOBILE_API_KEY;
      if (mobileKeySecret) {
        const clientKey = request.headers.get("x-mobile-key");
        if (clientKey !== mobileKeySecret) {
          return new Response(JSON.stringify({ status: "unauthorized", error: "Invalid x-mobile-key" }), { status: 401, headers: corsHeaders });
        }
      }
    }

    try {
      // /api/refresh -> เติม KV ทันที
      if (url.pathname === "/api/refresh") {
        const apiKey = env.WEATHERAPI_KEY || env.WEATHER_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ status: "error", message: "Missing WEATHERAPI_KEY secret" }), { status: 500, headers: corsHeaders });
        }
        const { results, failed, total } = await fetchAllWeather(apiKey);
        
        if (results.length > 0) {
          const payload = {
            status: "ok",
            version: "5.3-fixed",
            total_districts: results.length,
            failed: failed,
            updated_at: new Date().toISOString(),
            data: results
          };
          await env.WEATHER_KV.put("bangkok_all", JSON.stringify(payload));
        }

        return new Response(JSON.stringify({ 
          status: results.length > 0 ? "refreshed" : "failed",
          total: results.length,
          failed: failed,
          attempted: total,
          districts_loaded: DISTRICTS.length,
          message: results.length === 0 ? "Check WEATHER_API_KEY or logs" : undefined
        }), { headers: corsHeaders });
      }

      // /api/debug -> ดูว่า DISTRICTS โหลดได้ไหม + API KEY มีไหม
      if (url.pathname === "/api/debug") {
        return new Response(JSON.stringify({
          districts_in_code: DISTRICTS.length,
          has_weather_key: !!(env.WEATHERAPI_KEY || env.WEATHER_API_KEY),
          has_mobile_key: !!env.MOBILE_API_KEY,
          has_kv: !!env.WEATHER_KV,
          first_district: DISTRICTS[0] || null
        }), { headers: corsHeaders });
      }

      const raw = await env.WEATHER_KV.get("bangkok_all");
      if (!raw) {
        return new Response(JSON.stringify({ status: "warming_up", message: "KV empty. Call /api/refresh or check /api/debug" }), { status: 503, headers: corsHeaders });
      }
      const allPayload = JSON.parse(raw);

      if (url.pathname === "/api/bangkok/all") {
        const response = new Response(raw, { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      if (url.pathname === "/api/districts") {
        const list = allPayload.data.map(d => ({ id: d.id, name_th: d.name_th, name_en: d.name_en }));
        const response = new Response(JSON.stringify({ total: list.length, districts: list }), { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      if (url.pathname === "/api/weather") {
        const districtId = url.searchParams.get("district");
        if (!districtId) {
          return new Response(JSON.stringify({ error: "missing district param" }), { status: 400, headers: corsHeaders });
        }
        const found = allPayload.data.find(d => d.id === districtId.toLowerCase());
        if (!found) {
          return new Response(JSON.stringify({ error: `district '${districtId}' not found` }), { status: 404, headers: corsHeaders });
        }
        const singleResponse = {
          status: "ok",
          district: found.id,
          name_th: found.name_th,
          updated_at: found.updated_at,
          current: found.current,
          forecast: found.forecast
        };
        const response = new Response(JSON.stringify(singleResponse), { headers: corsHeaders });
        response.headers.set("Cache-Control", "public, max-age=1800");
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      return new Response(JSON.stringify({ status: "ok", version: "5.3-fixed", total_districts: allPayload.total_districts, updated_at: allPayload.updated_at }), { headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: e.message }), { status: 500, headers: corsHeaders });
    }
  }
}

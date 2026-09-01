/**
 * Weather Bangkok v5.2 - Dynamic District Filter (weatherapi.com edition)
 * - KV คีย์เดียว: bangkok_all (0.75MB) -> Write 48/วัน
 * - caches.default TTL 30 นาที -> Read แทบเป็น 0
 */

import * as districtsModule from './districts.js';
const DISTRICTS = districtsModule.default || districtsModule.DISTRICTS || districtsModule.districts || districtsModule.BANGKOK_DISTRICTS || [];

export default {
  // 1. Cron ทุก 30 นาที - ไปยิง weatherapi.com 50 เขต แล้วเก็บก้อนเดียว
  async scheduled(event, env, ctx) {
    try {
      const apiKey = env.WEATHERAPI_KEY;
      if (!apiKey) throw new Error("Missing WEATHERAPI_KEY");

      const results = await Promise.all(
        DISTRICTS.map(async (d) => {
          const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${d.lat},${d.lon}&days=7&aqi=no&alerts=no`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed ${d.id}: ${res.status}`);
          const json = await res.json();
          return {
            id: d.id, // เช่น lat_krabang, bang_kapi, lam_pla_thio
            name_th: d.name_th,
            name_en: d.name_en,
            lat: d.lat,
            lon: d.lon,
            current: json.current,
            forecast: json.forecast, // มี forecastday 7 วัน + hour 24 ชม. + chance_of_rain
            location: json.location,
            updated_at: new Date().toISOString()
          };
        })
      );

      const payload = {
        status: "ok",
        version: "5.2-dynamic-filter",
        total_districts: results.length,
        updated_at: new Date().toISOString(),
        data: results
      };

      // เก็บ KV คีย์เดียวจบ
      await env.WEATHER_KV.put("bangkok_all", JSON.stringify(payload));
      
      // ล้างตู้เย็นหน้าบ้านให้โหลดใหม่
      // (ใช้ cache.delete ถ้าต้องการ, แต่ปล่อยให้หมด TTL 30 นาทีเองก็ได้)

    } catch (e) {
      console.error("Cron error:", e);
    }
  },

  // 2. API สำหรับมือถือ
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    
    // ตู้เย็นหน้าบ้าน - ถ้ามีใน cache ส่งเลย ไม่ต้องอ่าน KV
    let response = await cache.match(cacheKey);
    if (response) return response;

    // CORS สำหรับ Flutter
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-mobile-key",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- เช็ค MOBILE KEY (ถ้าตั้ง Secret MOBILE_API_KEY ไว้ใน Cloudflare) ---
    if (url.pathname.startsWith("/api/")) {
      const mobileKeySecret = env.MOBILE_API_KEY;
      if (mobileKeySecret) { // จะเช็คต่อเมื่อพี่ตั้ง Secret ไว้แล้วเท่านั้น
        const clientKey = request.headers.get("x-mobile-key");
        if (clientKey !== mobileKeySecret) {
          return new Response(JSON.stringify({ status: "unauthorized", error: "Invalid x-mobile-key" }), { status: 401, headers: corsHeaders });
        }
      }
    }

    try {
      // ดึงก้อนเดียวจาก KV
      const raw = await env.WEATHER_KV.get("bangkok_all");
      if (!raw) {
        return new Response(JSON.stringify({ status: "warming_up", message: "KV empty, waiting for first cron" }), { status: 503, headers: corsHeaders });
      }
      const allPayload = JSON.parse(raw);

      // --- ROUTE 1: GET /api/bangkok/all -> ส่ง 50 เขต (เอาไว้ทำ Dropdown) ---
      if (url.pathname === "/api/bangkok/all") {
        response = new Response(raw, { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // --- ROUTE 2: GET /api/districts -> ส่งแค่รายชื่อเขตให้ Dropdown เบาๆ ---
      if (url.pathname === "/api/districts") {
        const list = allPayload.data.map(d => ({ id: d.id, name_th: d.name_th, name_en: d.name_en }));
        response = new Response(JSON.stringify({ total: list.length, districts: list }), { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // --- ROUTE 3: GET /api/weather?district=lat_krabang (Dynamic ตาม Dropdown) ---
      if (url.pathname === "/api/weather") {
        const districtId = url.searchParams.get("district");

        if (!districtId) {
          return new Response(JSON.stringify({ error: "missing district param, e.g. ?district=lat_krabang" }), { status: 400, headers: corsHeaders });
        }

        const found = allPayload.data.find(d => d.id === districtId.toLowerCase());

        if (!found) {
          return new Response(JSON.stringify({ error: `district '${districtId}' not found`, available: allPayload.data.map(d => d.id) }), { status: 404, headers: corsHeaders });
        }

        // ส่งกลับเฉพาะเขตเดียว ~15KB - ตรงกับที่ Flutter จะเอาไปวาดกราฟ
        const singleResponse = {
          status: "ok",
          district: found.id,
          name_th: found.name_th,
          updated_at: found.updated_at,
          current: found.current, // เอาไปใส่กล่อง 31°C
          forecast: found.forecast // เอาไปแยกทำ daily strip + hourly chart
        };

        response = new Response(JSON.stringify(singleResponse), { headers: corsHeaders });
        // เก็บ cache 30 นาที ตามตู้เย็นหน้าบ้าน
        response.headers.set("Cache-Control", "public, max-age=1800");
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // Health check
      return new Response(JSON.stringify({ status: "ok", version: "5.2-dynamic-filter", total_districts: allPayload.total_districts }), { headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: e.message }), { status: 500, headers: corsHeaders });
    }
  }
}

/**
 * Weather Bangkok v5.2 - Dynamic District Filter (weatherapi.com edition) FINAL
 * - แก้ import ให้ตรงกับ export const DISTRICTS
 * - รองรับ name / name_th ทั้งคู่
 * - มี MOBILE KEY scorpion
 * - มี /api/refresh ให้กดเติม KV เอง
 */

import { DISTRICTS } from './districts.js';

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
            id: d.id,
            name_th: d.name_th || d.name, // รองรับทั้ง name_th และ name
            name_en: d.name_en,
            lat: d.lat,
            lon: d.lon,
            current: json.current,
            forecast: json.forecast,
            location: json.location,
            updated_at: new Date().toISOString()
          };
        })
      );

      const payload = {
        status: "ok",
        version: "5.2-dynamic-filter-final",
        total_districts: results.length,
        updated_at: new Date().toISOString(),
        data: results
      };

      await env.WEATHER_KV.put("bangkok_all", JSON.stringify(payload));
      console.log(`Saved ${results.length} districts to KV`);

    } catch (e) {
      console.error("Cron error:", e);
    }
  },

  // 2. API สำหรับมือถือ
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    
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
      if (mobileKeySecret) {
        const clientKey = request.headers.get("x-mobile-key");
        if (clientKey !== mobileKeySecret) {
          return new Response(JSON.stringify({ status: "unauthorized", error: "Invalid x-mobile-key" }), { status: 401, headers: corsHeaders });
        }
      }
    }

    try {
      // --- ROUTE 0: GET /api/refresh -> สั่งให้เติม KV ทันที ไม่ต้องรอ Cron ---
      if (url.pathname === "/api/refresh") {
        // เรียก scheduled logic ซ้ำตรงๆ
        await this.scheduled(null, env, ctx);
        const raw = await env.WEATHER_KV.get("bangkok_all");
        const parsed = raw ? JSON.parse(raw) : null;
        return new Response(JSON.stringify({ 
          status: "refreshed", 
          total: parsed?.total_districts || 0,
          updated_at: parsed?.updated_at 
        }), { headers: corsHeaders });
      }

      // ดึงก้อนเดียวจาก KV
      const raw = await env.WEATHER_KV.get("bangkok_all");
      if (!raw) {
        return new Response(JSON.stringify({ status: "warming_up", message: "KV empty, waiting for first cron. Call /api/refresh to fill now." }), { status: 503, headers: corsHeaders });
      }
      const allPayload = JSON.parse(raw);

      // --- ROUTE 1: GET /api/bangkok/all -> ส่ง 50 เขต ---
      if (url.pathname === "/api/bangkok/all") {
        const response = new Response(raw, { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // --- ROUTE 2: GET /api/districts -> ส่งแค่รายชื่อเขตให้ Dropdown เบาๆ ---
      if (url.pathname === "/api/districts") {
        const list = allPayload.data.map(d => ({ id: d.id, name_th: d.name_th, name_en: d.name_en }));
        const response = new Response(JSON.stringify({ total: list.length, districts: list }), { headers: corsHeaders });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // --- ROUTE 3: GET /api/weather?district=lat_krabang ---
      if (url.pathname === "/api/weather") {
        const districtId = url.searchParams.get("district");

        if (!districtId) {
          return new Response(JSON.stringify({ error: "missing district param, e.g. ?district=lat_krabang" }), { status: 400, headers: corsHeaders });
        }

        const found = allPayload.data.find(d => d.id === districtId.toLowerCase());

        if (!found) {
          return new Response(JSON.stringify({ error: `district '${districtId}' not found`, available: allPayload.data.map(d => d.id) }), { status: 404, headers: corsHeaders });
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

      // Health check
      return new Response(JSON.stringify({ status: "ok", version: "5.2-dynamic-filter-final", total_districts: allPayload.total_districts, updated_at: allPayload.updated_at }), { headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ status: "error", message: e.message }), { status: 500, headers: corsHeaders });
    }
  }
}

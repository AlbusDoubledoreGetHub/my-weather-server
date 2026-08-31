import { DISTRICTS } from "./districts.js";

const CACHE_TTL = 1800; // 30 นาที
const API_DAYS = 3;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
      ...extraHeaders
    }
  });
}

function unauthorized() {
  return jsonResponse({ error: "Unauthorized", message: "Missing or invalid X-API-KEY" }, 401);
}

function checkApiKey(request, env) {
  // ถ้ายังไม่ได้ตั้ง MOBILE_API_KEY ใน Dashboard ให้ผ่านก่อน (dev mode)
  if (!env.MOBILE_API_KEY) return true;
  const key = request.headers.get("X-API-KEY") || request.headers.get("x-api-key") || new URL(request.url).searchParams.get("key");
  return key === env.MOBILE_API_KEY;
}

async function fetchFromWeatherAPI(district, env) {
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${env.WEATHER_API_KEY}&q=${district.lat},${district.lon}&days=${API_DAYS}&aqi=no&alerts=no&lang=th`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WeatherAPI error ${res.status}: ${text}`);
  }
  const data = await res.json();
  
  // แปลงให้เบาและตรงที่แอพต้องการ
  const simplified = {
    district_id: district.id,
    district_name: district.name,
    district_name_en: district.name_en,
    lat: district.lat,
    lon: district.lon,
    updated_at: new Date().toISOString(),
    current: {
      temp_c: data.current.temp_c,
      feelslike_c: data.current.feelslike_c,
      humidity: data.current.humidity,
      condition: data.current.condition.text,
      icon: data.current.condition.icon,
      wind_kph: data.current.wind_kph,
      chance_of_rain: data.forecast.forecastday[0].hour[new Date().getHours()]?.chance_of_rain ?? data.forecast.forecastday[0].day.daily_chance_of_rain
    },
    forecast: data.forecast.forecastday.map(fd => ({
      date: fd.date,
      maxtemp_c: fd.day.maxtemp_c,
      mintemp_c: fd.day.mintemp_c,
      daily_chance_of_rain: fd.day.daily_chance_of_rain,
      condition: fd.day.condition.text,
      hourly: fd.hour.map(h => ({
        time: h.time.split(" ")[1], // "14:00"
        temp_c: h.temp_c,
        chance_of_rain: h.chance_of_rain,
        condition: h.condition.text
      }))
    }))
  };
  return simplified;
}

async function getDistrictWeather(districtId, env, forceRefresh = false) {
  const district = DISTRICTS.find(d => d.id === districtId);
  if (!district) return null;
  
  const kvKey = `weather:bangkok:${districtId}:3d`;
  
  if (!forceRefresh) {
    const cached = await env.WEATHER_KV.get(kvKey, { type: "json" });
    if (cached) return cached;
  }
  
  const fresh = await fetchFromWeatherAPI(district, env);
  await env.WEATHER_KV.put(kvKey, JSON.stringify(fresh), { expirationTtl: CACHE_TTL });
  return fresh;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }

    // Public health check - ไม่ต้องใช้ API Key
    if (url.pathname === "/" || url.pathname === "/api") {
      return jsonResponse({ 
        status: "ok", 
        version: "5.0", 
        project: "Bangkok 50 Districts Proxy",
        endpoints: ["/api/districts", "/api/weather?district=lat_krabang", "/api/bangkok/all?days=3"],
        cache: "30m", forecast_days: 3, total_districts: DISTRICTS.length
      });
    }

    if (url.pathname === "/api/districts") {
      // อันนี้ให้ดูได้โดยไม่ต้องใช้ key ก็ได้ หรือจะล็อคก็ได้ - ตอนนี้เปิดไว้
      return jsonResponse({ count: DISTRICTS.length, districts: DISTRICTS });
    }

    // ตั้งแต่นี้ต้องเช็ค X-API-KEY
    if (!checkApiKey(request, env)) {
      return unauthorized();
    }

    try {
      if (url.pathname === "/api/weather") {
        const districtId = url.searchParams.get("district") || "lat_krabang";
        const data = await getDistrictWeather(districtId, env);
        if (!data) return jsonResponse({ error: "District not found" }, 404);
        return jsonResponse(data);
      }

      if (url.pathname === "/api/bangkok/all") {
        const allData = [];
        for (const d of DISTRICTS) {
          const kvKey = `weather:bangkok:${d.id}:3d`;
          const cached = await env.WEATHER_KV.get(kvKey, { type: "json" });
          if (cached) {
            allData.push(cached);
          } else {
            // ถ้าไม่มี cache ให้ fetch แบบขนาน แต่จำกัดเพื่อไม่ให้เกิน rate limit
            allData.push({ district_id: d.id, error: "not cached yet, will be available after next cron" });
          }
        }
        return jsonResponse({ 
          updated_at: new Date().toISOString(),
          count: allData.length,
          forecast_days: 3,
          data: allData 
        });
      }

      if (url.pathname === "/api/raw") {
        // สำหรับยิง lat/lon ตรงๆจาก GPS มือถือ
        const lat = url.searchParams.get("lat");
        const lon = url.searchParams.get("lon");
        if (!lat || !lon) return jsonResponse({ error: "lat, lon required" }, 400);
        const tempDistrict = { id: "custom", name: "Custom", name_en: "Custom", lat: parseFloat(lat), lon: parseFloat(lon) };
        const kvKey = `weather:custom:${lat},${lon}:3d`;
        const cached = await env.WEATHER_KV.get(kvKey, { type: "json" });
        if (cached) return jsonResponse(cached);
        const fresh = await fetchFromWeatherAPI(tempDistrict, env);
        await env.WEATHER_KV.put(kvKey, JSON.stringify(fresh), { expirationTtl: CACHE_TTL });
        return jsonResponse(fresh);
      }

      return jsonResponse({ error: "Not found" }, 404);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Cron ทุก 30 นาที - ไล่วอร์ม 50 เขต
    ctx.waitUntil((async () => {
      for (const district of DISTRICTS) {
        try {
          await getDistrictWeather(district.id, env, true); // forceRefresh = true
          // เว้น 1 วินาที กันโดน WeatherAPI rate limit
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.log(`Failed ${district.id}: ${err.message}`);
        }
      }
    })());
  }
};

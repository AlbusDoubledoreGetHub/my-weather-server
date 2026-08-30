// v4 Final - weatherapi.com - แก้โครงสร้าง forecast ให้ถูกต้อง
const CITIES = [
    { id: "latkrabang", q: "13.7226,100.7594", th: "ลาดกระบัง" },
    { id: "bangkok", q: "13.7563,100.5018", th: "กรุงเทพกลาง" },
    { id: "chiangmai", q: "18.7883,98.9853", th: "เชียงใหม่" },
    { id: "phuket", q: "7.8804,98.3923", th: "ภูเก็ต" },
];

async function fetchWeather(city, apiKey) {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${city.q}&days=1&aqi=no&alerts=no&lang=th`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`API Error ${city.id}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return data;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const apiKey = env.WEATHER_API_KEY;

        // ถ้าเรียก?refresh จะไปดึง API ใหม่และเก็บลง KV
        if (url.searchParams.has("refresh")) {
            if (!apiKey) return Response.json({ error: "ไม่มี WEATHER_API_KEY ใน env" }, { status: 500 });
            if (!env.WEATHER_KV) return Response.json({ error: "ไม่มี KV binding WEATHER_KV" }, { status: 500 });

            try {
                const results = await Promise.all(CITIES.map(c => fetchWeather(c, apiKey)));
                // เก็บลง KV
                for (let i = 0; i < CITIES.length; i++) {
                    await env.WEATHER_KV.put(CITIES[i].id, JSON.stringify(results[i]));
                }
                return Response.json({ ok: true, message: "Refresh สำเร็จ", cities: CITIES.map(c => c.th) });
            } catch (e) {
                return Response.json({ error: e.message }, { status: 500 });
            }
        }

        // อ่านข้อมูลหลัก = ลาดกระบัง
        let data = null;
        if (env.WEATHER_KV) {
            const cached = await env.WEATHER_KV.get("latkrabang");
            if (cached) data = JSON.parse(cached);
        }

        // ถ้าไม่มีใน KV ให้ดึงสดเลย (กรณีเพิ่ง deploy)
        if (!data) {
            if (!apiKey) return new Response("ยังไม่มีข้อมูลใน KV กรุณาเรียก?refresh&key=... ก่อน และต้องตั้ง WEATHER_API_KEY", { status: 500 });
            try {
                data = await fetchWeather(CITIES[0], apiKey);
            } catch (e) {
                return Response.json({ error: e.message, hint: "เช็ค API KEY, โควต้า, หรือเรียก?refresh" }, { status: 500 });
            }
        }

        // === จุดที่เคยแตก บรรทัด 47 ของคุณ แก้แล้วตรงนี้ ===
        const accept = request.headers.get("Accept") || "";
        if (accept.includes("application/json") || url.searchParams.has("json")) {
            return Response.json(data, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" } });
        }

        // กันแตก 100% - เช็คโครงสร้างใหม่ที่ถูกต้องของ weatherapi
        if (!data.forecast || !data.forecast.forecastday || !data.forecast.forecastday[0]) {
            return Response.json({ error: "โครงสร้าง forecast ไม่ถูกต้อง", data_preview: data }, { status: 500 });
        }

        const hours = data.forecast.forecastday[0].hour.slice(0, 24);
        const city_th = CITIES.find(c => c.id === "latkrabang")?.th || data.location.name;

        const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${city_th} - พยากรณ์อากาศ</title>
    <style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f0f8ff;margin:0;padding:20px}
  .card{background:white;border-radius:20px;padding:20px;max-width:700px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.1);overflow:hidden}
  .top{display:flex;align-items:center;gap:16px}.temp{font-size:56px;font-weight:800}
  .alert{padding:14px;border-radius:12px;margin:14px 0;font-weight:700;text-align:center}
  .rain{background:#fff176;border:1px solid #f9a825}.norain{background:#c8e6c9;border:1px solid #81c784}
  .chart{margin-top:20px;overflow:hidden}
  .bar-row{display:flex;align-items:end;gap:6px;height:140px;overflow-x:auto;padding-bottom:8px;scrollbar-width:thin}
  .bar-col{flex:0 0 32px;display:flex;flex-direction:column;align-items:center;justify-content:end;gap:4px}
  .bar{background:linear-gradient(#42a5f5,#1976d2);border-radius:6px 6px 0 0;width:100%;min-height:4px;transition:height 0.3s}
  .bar-col small{font-size:11px;white-space:nowrap}
</style></head><body>
    <div class="card">
      <div class="top"><div class="temp">${data.current.temp_c}°C</div><div><b>${city_th}</b><br>${data.current.condition.text}<br>รู้สึกเหมือน ${data.current.feelslike_c}°C</div></div>
      <div class="alert ${hours.some(h => h.chance_of_rain > 50) ? 'rain' : 'norain'}">${hours.some(h => h.chance_of_rain > 50) ? 'วันนี้มีโอกาสฝนตก' : 'วันนี้อากาศดี ไม่มีฝน'}</div>
      <div class="chart"><b>24 ชั่วโมงข้างหน้า</b><div class="bar-row">
        ${hours.map(h => `<div class="bar-col"><div class="bar" style="height:${Math.max(4, h.chance_of_rain)}%"></div><small>${h.chance_of_rain}%</small><small>${new Date(h.time).getHours()}น</small></div>`).join('')}
      </div></div>
      <p style="text-align:center;margin-top:20px"><a href="?json">ดู JSON</a> | <a href="?refresh">Refresh ข้อมูล</a></p>
    </div></body></html>`;

        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },

    // Cron ดึงทุกชั่วโมง
    async scheduled(event, env, ctx) {
        const apiKey = env.WEATHER_API_KEY;
        if (!apiKey || !env.WEATHER_KV) return;
        ctx.waitUntil((async () => {
            const results = await Promise.all(CITIES.map(c => fetchWeather(c, apiKey)));
            for (let i = 0; i < CITIES.length; i++) {
                await env.WEATHER_KV.put(CITIES[i].id, JSON.stringify(results[i]));
            }
        })());
    }
};
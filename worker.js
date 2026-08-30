export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(this.doFetchAll(env));
    },

    async doFetchAll(env) {
        const cities = [
            { id: "latkrabang", q: "13.7226,100.7594", th: "ลาดกระบัง" },
            { id: "bangkok", q: "13.7563,100.5018", th: "กรุงเทพกลาง" },
            { id: "chiang mai", q: "18.7883,98.9853", th: "เชียงใหม่" },
            { id: "phuket", q: "7.8804,98.3923", th: "ภูเก็ต" },
        ];

        await Promise.all(cities.map(async (city) => {
            try {
                const url = `https://api.weatherapi.com/v1/forecast.json?key=${env.WEATHER_API_KEY}&q=${city.q}&days=3&aqi=no&alerts=no&lang=th`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(city.id);
                const data = await res.json();
                // ... โค้ด simplified เดิม ...
                const simplified = {
                    city: city.id,
                    city_th: city.th, // ใช้ชื่อไทยที่เราตั้งเองเลย แม่นๆ
                    // ... ที่เหลือเหมือนเดิม
                };
                await env.WEATHER_KV.put(city.id, JSON.stringify(simplified), { expirationTtl: 7200 });
            } catch (e) { }
        }));
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === "/refresh") {
            await this.doFetchAll(env);
            return new Response(`<script>location.href="/?city=bangkok"</script><h1>กำลังดึงข้อมูลใหม่...</h1>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const city = (url.searchParams.get("city") || "bangkok").toLowerCase();
        let data = await env.WEATHER_KV.get(city, "json");
        if (!data) {
            // ถ้าไม่มีข้อมูลเมืองนั้น ให้ลองดึงสดทันที
            await this.doFetchAll(env);
            data = await env.WEATHER_KV.get(city, "json");
        }
        if (!data) return Response.json({ error: "ยังไม่มีข้อมูล ให้เปิด /refresh ก่อน" }, { status: 503 });

        const accept = request.headers.get("Accept") || "";
        if (accept.includes("application/json") || url.searchParams.has("json")) {
            return Response.json(data, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" } });
        }

        const hours = data.forecast[0].hour.slice(0, 24);
        const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${data.city_th} - พยากรณ์อากาศ</title>
    <style>
      *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f0f4f8;margin:0;padding:16px}
    .card{background:white;border-radius:20px;padding:20px;max-width:600px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,.08)}
    .top{display:flex;align-items:center;gap:16px}.temp{font-size:56px;font-weight:800}
    .alert{padding:14px;border-radius:12px;margin:14px 0;font-weight:700;text-align:center}
    .rain{background:#fff176;border:1px solid #f9a825}.norain{background:#c8e6c9;border:1px solid #66bb6a}
    .chart{margin-top:20px}.bar-row{display:flex;align-items:end;gap:4px;height:120px;border-bottom:1px solid #ddd;padding-bottom:4px;overflow-x:auto}
    .bar-col{flex:1;min-width:28px;display:flex;flex-direction:column;align-items:center;gap:4px}
    .bar{width:100%;border-radius:6px 6px 0 0;background:#90caf9}
    .bar.rain50{background:#ffca28}.bar.rain70{background:#ff9800}.bar.rain80{background:#ef5350}
    .label{font-size:10px;color:#666}.pct{font-size:11px;font-weight:700}
    </style></head><body><div class="card">
    <div class="top"><img src="https:${data.current.icon}" width="64"><div><h2 style="margin:0">${data.city_th}</h2><div>${data.current.condition_th} | ชื้น ${data.current.humidity}% | ลม ${data.current.wind_kph} km/h</div></div><div class="temp">${data.current.temp_c}°C</div></div>
    <div class="alert ${data.today.will_rain ? 'rain' : 'norain'}">${data.today.alert_message} (สูง ${data.today.max_c}° / ต่ำ ${data.today.min_c}°)</div>
    <div class="chart"><h3>☔ โอกาสฝนรายชั่วโมง</h3><div class="bar-row">
        ${hours.map(h => {
            const pct = h.chance_of_rain;
            const cls = pct >= 80 ? 'rain80' : pct >= 60 ? 'rain70' : pct >= 40 ? 'rain50' : '';
            const time = h.time.split(' ')[1].substring(0, 5);
            return `<div class="bar-col"><div class="pct">${pct}%</div><div class="bar ${cls}" style="height:${pct}%;min-height:4px"></div><div class="label">${time}</div></div>`;
        }).join('')}
      </div></div>
    <p style="font-size:11px;color:#999;text-align:center;margin-top:16px">อัปเดต ${new Date(data.updated_at).toLocaleString('th-TH')} | <a href="/refresh">รีเฟรช</a> | <a href="/?json=1">JSON</a></p>
    </div></body></html>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    }
}
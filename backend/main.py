
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import bigquery
import time

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def home():
    return {"message": "VM Capacity Planning Tool — Running"}

@app.get("/test")
def test():
    return {"status": "ok"}

@app.get("/debug")
def debug():
    client = bigquery.Client()
    q = """
        SELECT DISTINCT metric_type, COUNT(*) as row_count
        FROM `vm_capacity.metrics`
        GROUP BY metric_type
        ORDER BY row_count DESC
    """
    rows = list(client.query(q))
    result = [{"metric_type": r.metric_type, "row_count": r.row_count} for r in rows]
    return {
        "distinct_metric_types": result,
        "total_rows": sum(r.row_count for r in rows),
        "hint": "Use these metric_type values to configure CPU_KEYWORDS and MEM_KEYWORDS"
    }

CPU_KEYWORDS = ["cpu", "utilization", "compute", "processor"]
MEM_KEYWORDS = ["mem", "memory", "ram", "bytes"]

FORECAST_STEPS = 10
READINGS_LIMIT = 50
CPU_THRESHOLD  = 0.80
MEM_THRESHOLD  = 0.20

def linear_regression(values: list):
    n = len(values)
    if n < 2:
        return None
    x     = list(range(1, n + 1))
    x_bar = sum(x) / n
    y_bar = sum(values) / n
    num   = sum((x[i] - x_bar) * (values[i] - y_bar) for i in range(n))
    den   = sum((xi - x_bar) ** 2 for xi in x)
    if den == 0:
        return None
    m = num / den
    c = y_bar - m * x_bar
    trend_line = [round(max(0.0, min(1.0, m * xi + c)), 6) for xi in x]
    forecast   = [round(max(0.0, min(1.0, m * (n + i) + c)), 6)
                  for i in range(1, FORECAST_STEPS + 1)]
    direction  = "rising" if m > 0.002 else "falling" if m < -0.002 else "stable"
    return {"slope": round(m,6), "intercept": round(c,6),
            "trend_line": trend_line, "forecast": forecast,
            "direction": direction, "n": n}

def predict_breach(trend, current_n, threshold):
    if not trend:
        return None
    m, c = trend["slope"], trend["intercept"]
    if m <= 0:
        return {"will_breach": False, "reason": "Trend is flat or falling — no breach expected"}
    x_breach      = (threshold - c) / m
    readings_away = x_breach - current_n
    if readings_away <= 0:
        return {"will_breach": True, "readings_until_breach": 0,
                "minutes_until_breach": 0, "note": "Already at or above threshold"}
    minutes = round(readings_away)
    return {"will_breach": minutes < 120,
            "readings_until_breach": round(readings_away, 1),
            "minutes_until_breach": minutes,
            "note": f"Predicted breach in ~{minutes} min at current rate"}

def fetch_metric(client, keywords, exclude_keywords, limit):
    conditions = " OR ".join(f"LOWER(metric_type) LIKE '%{kw.lower()}%'" for kw in keywords)
    q = f"""
        SELECT metric_type, metric_value FROM `vm_capacity.metrics`
        WHERE {conditions}
        ORDER BY timestamp DESC LIMIT {limit}
    """
    rows = list(client.query(q))
    if rows:
        matched = list({r.metric_type for r in rows})
        values  = list(reversed([round(float(r.metric_value), 6) for r in rows]))
        return values, "keywords_match", matched
    excl = " AND ".join(f"LOWER(metric_type) NOT LIKE '%{kw.lower()}%'" for kw in exclude_keywords)
    q2 = f"""
        SELECT metric_type, metric_value FROM `vm_capacity.metrics`
        WHERE {excl}
        ORDER BY timestamp DESC LIMIT {limit}
    """
    rows2 = list(client.query(q2))
    if rows2:
        matched = list({r.metric_type for r in rows2})
        values  = list(reversed([round(float(r.metric_value), 6) for r in rows2]))
        return values, "fallback_exclude", matched
    return [], "no_match", []

@app.get("/metrics")
def get_metrics():
    client = bigquery.Client()
    cpu_vals, cpu_strat, cpu_types = fetch_metric(client, CPU_KEYWORDS, MEM_KEYWORDS, READINGS_LIMIT)
    mem_vals, mem_strat, mem_types = fetch_metric(client, MEM_KEYWORDS, CPU_KEYWORDS, READINGS_LIMIT)
    cpu_newest = list(reversed(cpu_vals))
    mem_newest = list(reversed(mem_vals))
    cpu_trend  = linear_regression(cpu_vals)
    mem_trend  = linear_regression(mem_vals)
    cpu_breach = predict_breach(cpu_trend, len(cpu_vals), CPU_THRESHOLD)
    mem_breach = predict_breach(mem_trend, len(mem_vals), MEM_THRESHOLD)
    def safe_avg(lst): return round(sum(lst)/len(lst), 6) if lst else 0
    def safe_max(lst): return round(max(lst), 6) if lst else 0
    return {
        "cpu": cpu_newest, "memory": mem_newest,
        "timestamps": [int(time.time()) - i*60 for i in range(max(len(cpu_newest), len(mem_newest)))],
        "stats": {"cpu_avg": safe_avg(cpu_newest), "cpu_peak": safe_max(cpu_newest),
                  "mem_avg": safe_avg(mem_newest), "mem_peak": safe_max(mem_newest)},
        "cpu_trend": cpu_trend, "mem_trend": mem_trend,
        "cpu_breach": cpu_breach, "mem_breach": mem_breach,
        "_debug": {"cpu_rows_fetched": len(cpu_vals), "mem_rows_fetched": len(mem_vals),
                   "cpu_strategy": cpu_strat, "mem_strategy": mem_strat,
                   "cpu_metric_types": cpu_types, "mem_metric_types": mem_types}
    }

@app.get("/report")
def get_report():
    client = bigquery.Client()
    cpu_vals, _, _ = fetch_metric(client, CPU_KEYWORDS, MEM_KEYWORDS, 200)
    mem_vals, _, _ = fetch_metric(client, MEM_KEYWORDS, CPU_KEYWORDS, 200)
    cpu_trend  = linear_regression(cpu_vals)
    mem_trend  = linear_regression(mem_vals)
    cpu_breach = predict_breach(cpu_trend, len(cpu_vals), CPU_THRESHOLD)
    mem_breach = predict_breach(mem_trend, len(mem_vals), MEM_THRESHOLD)
    def pct(v):   return f"{round(v*100,1)}%" if v is not None else "N/A"
    def s_avg(l): return sum(l)/len(l) if l else 0
    def s_max(l): return max(l) if l else 0
    def s_min(l): return min(l) if l else 0
    rec = "No action needed — all metrics within safe range"
    if cpu_trend and cpu_trend["direction"]=="rising" and cpu_breach and cpu_breach.get("minutes_until_breach",999)<60:
        rec = "SCALE UP CPU immediately — breach predicted within 1 hour"
    elif mem_trend and mem_trend["direction"]=="rising" and mem_breach and mem_breach.get("minutes_until_breach",999)<60:
        rec = "SCALE UP MEMORY immediately — breach predicted within 1 hour"
    elif (cpu_trend and cpu_trend["direction"]=="rising") or (mem_trend and mem_trend["direction"]=="rising"):
        rec = "Monitor closely — one or more metrics are trending upward"
    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sample_count": {"cpu": len(cpu_vals), "memory": len(mem_vals)},
        "thresholds":   {"cpu": pct(CPU_THRESHOLD), "memory": pct(MEM_THRESHOLD)},
        "cpu": {
            "avg": pct(s_avg(cpu_vals)), "peak": pct(s_max(cpu_vals)), "min": pct(s_min(cpu_vals)),
            "slope": f"{round((cpu_trend['slope'] if cpu_trend else 0)*100,4)}% per reading",
            "direction": cpu_trend["direction"] if cpu_trend else "unknown (< 2 rows)",
            "n_points": len(cpu_vals),
            "forecast_next_3": [pct(v) for v in (cpu_trend["forecast"][:3] if cpu_trend else [])],
            "breach": cpu_breach,
        },
        "memory": {
            "avg": pct(s_avg(mem_vals)), "peak": pct(s_max(mem_vals)), "min": pct(s_min(mem_vals)),
            "slope": f"{round((mem_trend['slope'] if mem_trend else 0)*100,4)}% per reading",
            "direction": mem_trend["direction"] if mem_trend else "unknown (< 2 rows)",
            "n_points": len(mem_vals),
            "forecast_next_3": [pct(v) for v in (mem_trend["forecast"][:3] if mem_trend else [])],
            "breach": mem_breach,
        },
        "recommendation": rec,
    }
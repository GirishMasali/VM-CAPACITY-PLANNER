// ─── Config ─────────────────────────────────────────────────────────────────
const BACKEND_URL   = "http://35.200.143.64:8000/metrics";
const THRESHOLD     = 0.85;      // 85% — trigger autoscale alert above this
const REFRESH_MS    = 10_000;    // refresh every 10 seconds
const MAX_POINTS    = 20;        // keep last N points on the line chart

// ─── State ───────────────────────────────────────────────────────────────────
let lineChart    = null;
let scatterChart = null;
let modalShown   = false;

// ─── Chart.js global defaults ────────────────────────────────────────────────
Chart.defaults.color           = "#a0aec0";
Chart.defaults.borderColor     = "#2d3748";
Chart.defaults.font.family     = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pct(v)    { return (v * 100).toFixed(1) + "%"; }
function avg(arr)  { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }
function peak(arr) { return arr.length ? Math.max(...arr) : 0; }

function tsLabel(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Build charts (first run) ─────────────────────────────────────────────────
function buildLineChart(labels, cpuData, memData) {
    const ctx = document.getElementById("lineChart").getContext("2d");
    const thresholdPlugin = {
        id: "thresholdLine",
        afterDraw(chart) {
            const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
            const yPos = y.getPixelForValue(THRESHOLD);
            c.save();
            c.beginPath();
            c.setLineDash([6, 4]);
            c.strokeStyle = "#fc8181";
            c.lineWidth = 1.5;
            c.moveTo(left, yPos);
            c.lineTo(right, yPos);
            c.stroke();
            c.restore();
        }
    };

    lineChart = new Chart(ctx, {
        type: "line",
        plugins: [thresholdPlugin],
        data: {
            labels,
            datasets: [
                {
                    label: "CPU",
                    data: cpuData,
                    borderColor: "#63b3ed",
                    backgroundColor: "rgba(99,179,237,.1)",
                    tension: 0.4,
                    pointRadius: 3,
                    fill: true,
                },
                {
                    label: "Memory",
                    data: memData,
                    borderColor: "#68d391",
                    backgroundColor: "rgba(104,211,145,.08)",
                    tension: 0.4,
                    pointRadius: 3,
                    fill: true,
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            scales: {
                y: {
                    min: 0, max: 1,
                    ticks: {
                        callback: v => (v * 100) + "%",
                        stepSize: 0.2
                    },
                    grid: { color: "#2d3748" }
                },
                x: {
                    grid: { color: "#2d3748" },
                    ticks: { maxTicksLimit: 8 }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${pct(ctx.raw)}`
                    }
                }
            }
        }
    });
}

function buildScatterChart(cpuData, memData) {
    const ctx = document.getElementById("scatterChart").getContext("2d");

    const normal  = [], high = [];
    cpuData.forEach((c, i) => {
        const m = memData[i] ?? 0;
        const pt = { x: c, y: m };
        (c > THRESHOLD && m > THRESHOLD) ? high.push(pt) : normal.push(pt);
    });

    scatterChart = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "Normal",
                    data: normal,
                    backgroundColor: "rgba(99,179,237,.75)",
                    pointRadius: 6,
                },
                {
                    label: "High load (both > 85%)",
                    data: high,
                    backgroundColor: "rgba(252,129,129,.85)",
                    pointRadius: 7,
                    pointStyle: "triangle",
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    title: { display: true, text: "CPU Usage", color: "#718096" },
                    min: 0, max: 1,
                    ticks: { callback: v => (v*100)+"%" },
                    grid: { color: "#2d3748" }
                },
                y: {
                    title: { display: true, text: "Memory Usage", color: "#718096" },
                    min: 0, max: 1,
                    ticks: { callback: v => (v*100)+"%" },
                    grid: { color: "#2d3748" }
                }
            },
            plugins: {
                legend: { labels: { color: "#a0aec0" } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` CPU: ${pct(ctx.raw.x)}, Mem: ${pct(ctx.raw.y)}`
                    }
                }
            }
        }
    });
}

// ─── Update charts (subsequent runs) ─────────────────────────────────────────
function updateLineChart(labels, cpuData, memData) {
    lineChart.data.labels              = labels;
    lineChart.data.datasets[0].data   = cpuData;
    lineChart.data.datasets[1].data   = memData;
    lineChart.update("none");
}

function updateScatterChart(cpuData, memData) {
    const normal = [], high = [];
    cpuData.forEach((c, i) => {
        const m = memData[i] ?? 0;
        const pt = { x: c, y: m };
        (c > THRESHOLD && m > THRESHOLD) ? high.push(pt) : normal.push(pt);
    });
    scatterChart.data.datasets[0].data = normal;
    scatterChart.data.datasets[1].data = high;
    scatterChart.update("none");
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
function checkThreshold(cpuData, memData) {
    const avgCpu = avg(cpuData);
    const avgMem = avg(memData);
    const pkCpu  = peak(cpuData);
    const pkMem  = peak(memData);

    // Alert if average OR both peaks exceed threshold
    const triggered = avgCpu > THRESHOLD || avgMem > THRESHOLD
                   || (pkCpu > THRESHOLD && pkMem > THRESHOLD);

    const banner = document.getElementById("alert-banner");
    const detail = document.getElementById("alert-detail");

    if (triggered) {
        detail.textContent = ` — Avg CPU: ${pct(avgCpu)}, Avg Mem: ${pct(avgMem)}. Consider scaling up.`;
        banner.classList.remove("hidden");

        if (!modalShown) {
            modalShown = true;
            document.getElementById("modal-stats").innerHTML =
                `<div>Average CPU &nbsp;: <strong>${pct(avgCpu)}</strong></div>
                 <div>Average Memory: <strong>${pct(avgMem)}</strong></div>
                 <div>Peak CPU &nbsp;&nbsp;&nbsp;: <strong>${pct(pkCpu)}</strong></div>
                 <div>Peak Memory &nbsp;: <strong>${pct(pkMem)}</strong></div>`;
            document.getElementById("autoscale-modal").classList.remove("hidden");
        }
    } else {
        banner.classList.add("hidden");
    }
}

function closeModal() {
    document.getElementById("autoscale-modal").classList.add("hidden");
    // Allow re-triggering after 5 minutes if situation persists
    setTimeout(() => { modalShown = false; }, 300_000);
}

// ─── Stat cards ───────────────────────────────────────────────────────────────
function updateStats(cpuData, memData) {
    const metrics = [
        { id: "stat-cpu",      card: "card-cpu",      val: avg(cpuData)  },
        { id: "stat-mem",      card: "card-mem",      val: avg(memData)  },
        { id: "stat-peak-cpu", card: "card-peak-cpu", val: peak(cpuData) },
        { id: "stat-peak-mem", card: "card-peak-mem", val: peak(memData) },
    ];
    metrics.forEach(({ id, card, val }) => {
        document.getElementById(id).textContent = pct(val);
        document.getElementById(card).classList.toggle("warning", val > THRESHOLD);
    });
}
// ── Autoscale status polling ──────────────────────────────────────
let newVmIp = null;

async function checkAutoscaleStatus(){
  try{
    const res = await fetch(BACKEND_URL + "/autoscale-status");
    if(!res.ok) return;
    const data = await res.json();
    const banner = document.getElementById("autoscale-banner");
    const text   = document.getElementById("autoscale-text");
    const ipTag  = document.getElementById("autoscale-new-ip");

    if(data.triggered){
      // Extract IP from message if available
      const ipMatch = data.message.match(/(\d+\.\d+\.\d+\.\d+)/);
      if(ipMatch){
        newVmIp = ipMatch[1];
        ipTag.textContent = "New VM: " + newVmIp + ":8000";
        document.getElementById("autoscale-switch-btn").style.display = "inline-block";
      } else {
        ipTag.textContent = "";
        document.getElementById("autoscale-switch-btn").style.display = "none";
      }
      text.textContent = " — " + data.message;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  } catch(e){
    // silently ignore — autoscale endpoint may not exist yet
  }
}

function switchToNewVM(){
  if(newVmIp){
    const newUrl = "http://" + newVmIp + ":8000";
    if(confirm("Switch dashboard to new VM at " + newUrl + "?\n\nThis will reload the page connected to the new VM.")){
      // Update BACKEND_URL and reload
      localStorage.setItem("override_backend", newUrl);
      window.location.reload();
    }
  }
}

function acknowledgeAutoscale(){
  document.getElementById("autoscale-banner").classList.add("hidden");
  fetch(BACKEND_URL + "/autoscale-reset", {method:"POST"}).catch(()=>{});
}

// Check BACKEND_URL override from localStorage (set by switchToNewVM)
const _override = localStorage.getItem("override_backend");
if(_override){ 
  // Note: Can't reassign const, so we use a wrapper
  window._backendOverride = _override;
}
// ─── Main fetch + render ──────────────────────────────────────────────────────
async function loadData() {
    try {
        const res  = await fetch(BACKEND_URL);
        const data = await res.json();

        const { cpu = [], memory = [], timestamps = [] } = data;

        // Slice to MAX_POINTS
        const cpuSlice  = cpu.slice(0, MAX_POINTS);
        const memSlice  = memory.slice(0, MAX_POINTS);
        const tsSlice   = timestamps.slice(0, MAX_POINTS);

        // Build readable x-axis labels
        const labels = tsSlice.length
            ? tsSlice.map(tsLabel)
            : cpuSlice.map((_, i) => `T-${cpuSlice.length - i}`);

        // Build / update charts
        if (!lineChart) {
            buildLineChart(labels, cpuSlice, memSlice);
            buildScatterChart(cpuSlice, memSlice);
        } else {
            updateLineChart(labels, cpuSlice, memSlice);
            updateScatterChart(cpuSlice, memSlice);
        }

        updateStats(cpuSlice, memSlice);
        checkThreshold(cpuSlice, memSlice);

        document.getElementById("last-updated").textContent =
            "Last updated: " + new Date().toLocaleTimeString();

    } catch (err) {
        console.error("Fetch error:", err);
        document.getElementById("last-updated").textContent = "⚠ Failed to fetch data";
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.closeModal = closeModal;
loadData();
setInterval(loadData, REFRESH_MS);

// Check autoscale status every 15 seconds
checkAutoscaleStatus();
setInterval(checkAutoscaleStatus, 15000);
// ═══════════════════════════════════════════════════════════════════════════════
// VM CAPACITY PLANNER — Autoscaling Dashboard Script
// Features: Live Dashboard, Capacity Reports, Acknowledgements, VM Management
// ═══════════════════════════════════════════════════════════════════════════════

// CONFIG
const BACKEND_URL = "http://35.200.143.64:8000";
const THRESHOLD = 0.85;
const REFRESH_MS = 10_000;
const MAX_POINTS = 20;

// STATE
let lineChart = null;
let scatterChart = null;
let modalShown = false;
let pendingAcknowledgement = null;
let autoscaleHistory = [];

// Chart.js Setup
Chart.defaults.color = "#a0aec0";
Chart.defaults.borderColor = "#2d3748";
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function pct(v) { 
    return (typeof v === 'string') ? v : (v * 100).toFixed(1) + "%"; 
}

function avg(arr) { 
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; 
}

function peak(arr) { 
    return arr.length ? Math.max(...arr) : 0; 
}

function tsLabel(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function switchTab(event, tabName) {
    if (event) event.preventDefault();
    
    // Hide all panels
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    
    // Show selected panel
    const panel = document.getElementById(tabName);
    if (panel) {
        panel.classList.add("active");
    }
    
    // Mark button as active
    event.target.classList.add("active");
    
    // Load specific data if needed
    if (tabName === "capacity-report") {
        loadCapacityReport();
    } else if (tabName === "vm-management") {
        loadVMManagement();
    } else if (tabName === "acknowledgement") {
        loadAcknowledgements();
    }
}

function closeAlertBanner() {
    document.getElementById("alert-banner").classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════════════════════════════════════════

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

    const normal = [], high = [];
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
                    ticks: { callback: v => (v * 100) + "%" },
                    grid: { color: "#2d3748" }
                },
                y: {
                    title: { display: true, text: "Memory Usage", color: "#718096" },
                    min: 0, max: 1,
                    ticks: { callback: v => (v * 100) + "%" },
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

function updateLineChart(labels, cpuData, memData) {
    lineChart.data.labels = labels;
    lineChart.data.datasets[0].data = cpuData;
    lineChart.data.datasets[1].data = memData;
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

// ═══════════════════════════════════════════════════════════════════════════════
// STAT CARDS & ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

function updateStats(cpuData, memData) {
    const metrics = [
        { id: "stat-cpu", card: "card-cpu", val: avg(cpuData) },
        { id: "stat-mem", card: "card-mem", val: avg(memData) },
        { id: "stat-peak-cpu", card: "card-peak-cpu", val: peak(cpuData) },
        { id: "stat-peak-mem", card: "card-peak-mem", val: peak(memData) },
    ];
    
    metrics.forEach(({ id, card, val }) => {
        document.getElementById(id).textContent = pct(val);
        const cardEl = document.getElementById(card);
        
        if (val > THRESHOLD) {
            cardEl.classList.add("critical");
            cardEl.classList.remove("warning");
        } else if (val > THRESHOLD * 0.8) {
            cardEl.classList.add("warning");
            cardEl.classList.remove("critical");
        } else {
            cardEl.classList.remove("warning", "critical");
        }
    });
}

function checkThreshold(cpuData, memData) {
    const avgCpu = avg(cpuData);
    const avgMem = avg(memData);
    const pkCpu = peak(cpuData);
    const pkMem = peak(memData);

    const triggered = avgCpu > THRESHOLD || avgMem > THRESHOLD ||
        (pkCpu > THRESHOLD && pkMem > THRESHOLD);

    const banner = document.getElementById("alert-banner");
    const detail = document.getElementById("alert-text");

    if (triggered) {
        detail.textContent = ` — Avg CPU: ${pct(avgCpu)}, Avg Mem: ${pct(avgMem)}. Consider scaling up.`;
        banner.classList.remove("hidden");

        if (!modalShown) {
            modalShown = true;
            document.getElementById("modal-cpu").textContent = pct(avgCpu);
            document.getElementById("modal-mem").textContent = pct(avgMem);
            document.getElementById("autoscale-modal").classList.add("active");
        }
    } else {
        banner.classList.add("hidden");
    }
    
    // Update status indicator
    const statusDot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    
    if (avgCpu > THRESHOLD || avgMem > THRESHOLD) {
        statusDot.classList.add("critical");
        statusText.textContent = "Critical Resources";
    } else if (avgCpu > THRESHOLD * 0.7 || avgMem > THRESHOLD * 0.7) {
        statusDot.classList.add("warning");
        statusDot.classList.remove("critical");
        statusText.textContent = "High Usage";
    } else {
        statusDot.classList.remove("warning", "critical");
        statusText.textContent = "System Normal";
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOSCALING
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAutoscaleStatus() {
    try {
        const res = await fetch(BACKEND_URL + "/autoscale-status");
        if (!res.ok) return;

        const data = await res.json();
        const alertBanner = document.getElementById("autoscale-alert");
        const ackTab = document.getElementById("ack-tab");

        if (data.triggered && data.pending) {
            // Show pending acknowledgement
            pendingAcknowledgement = data.pending;
            
            const message = `⚡ CRITICAL: CPU ${pct(data.cpu_usage)} | Memory ${pct(data.memory_usage)} — Switching from ${data.new_vm_id}`;
            document.getElementById("autoscale-message").textContent = message;
            alertBanner.classList.remove("hidden");
            
            // Highlight acknowledgement tab
            ackTab.classList.add("alert");
            
            // Show modal
            showAutoscaleModal(data);
            
            // Add to history
            autoscaleHistory.unshift({
                timestamp: new Date().toISOString(),
                type: "triggered",
                cpu: data.cpu_usage,
                memory: data.memory_usage,
                newVm: data.new_vm_id,
                eventId: data.pending.event_id
            });
        } else {
            alertBanner.classList.add("hidden");
            ackTab.classList.remove("alert");
        }
    } catch (e) {
        console.error("Autoscale check error:", e);
    }
}

function showAutoscaleModal(data) {
    if (!modalShown) {
        modalShown = true;
        document.getElementById("modal-cpu").textContent = pct(data.cpu_usage);
        document.getElementById("modal-mem").textContent = pct(data.memory_usage);
        document.getElementById("modal-new-vm").textContent = data.new_vm_id || "N/A";
        document.getElementById("autoscale-modal").classList.add("active");
    }
}

async function acknowledgeAutoscale(action) {
    if (!pendingAcknowledgement) {
        alert("No pending autoscale event");
        return;
    }

    try {
        const eventId = pendingAcknowledgement.event_id;
        const res = await fetch(
            `${BACKEND_URL}/autoscale-acknowledge?event_id=${eventId}&action=${action}`,
            { method: "POST" }
        );

        if (!res.ok) throw new Error("HTTP " + res.status);
        const result = await res.json();

        // Update history
        autoscaleHistory[0].action = action;
        autoscaleHistory[0].acknowledged_at = new Date().toISOString();
        autoscaleHistory[0].acknowledged = true;

        // Close modal
        document.getElementById("autoscale-modal").classList.remove("active");
        modalShown = false;
        pendingAcknowledgement = null;

        // Show success banner
        const banner = document.getElementById("autoscale-alert");
        document.getElementById("autoscale-message").textContent = `✅ ${result.message}`;
        banner.classList.add("success");

        // Hide after 3 seconds
        setTimeout(() => {
            banner.classList.add("hidden");
            banner.classList.remove("success");
        }, 3000);

        // Reload data
        setTimeout(() => loadData(), 1000);

    } catch (e) {
        console.error("Acknowledge error:", e);
        alert("Error acknowledging autoscale: " + e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD CAPACITY REPORT
// ═══════════════════════════════════════════════════════════════════════════════

async function loadCapacityReport() {
    try {
        const res = await fetch(BACKEND_URL + "/capacity-report-detailed");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // CPU Analysis
        document.getElementById("report-cpu-avg").textContent = data.cpu.avg;
        document.getElementById("report-cpu-peak").textContent = data.cpu.peak;
        document.getElementById("report-cpu-min").textContent = data.cpu.min;
        document.getElementById("report-cpu-trend").textContent = data.cpu.direction.toUpperCase();

        // Memory Analysis
        document.getElementById("report-mem-avg").textContent = data.memory.avg;
        document.getElementById("report-mem-peak").textContent = data.memory.peak;
        document.getElementById("report-mem-min").textContent = data.memory.min;
        document.getElementById("report-mem-trend").textContent = data.memory.direction.toUpperCase();

        // Autoscale Events
        const historyContainer = document.getElementById("autoscale-history-container");
        const autoscaleEvents = data.autoscale?.autoscale_events || [];

        if (autoscaleEvents.length === 0) {
            historyContainer.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 40px 20px;">
                    <p style="margin-bottom: 10px;">✓ No autoscaling events yet</p>
                    <p style="font-size: 12px;">System is operating within normal parameters</p>
                </div>
            `;
        } else {
            historyContainer.innerHTML = `
                <div class="timeline" style="margin: 20px 0;">
                    ${autoscaleEvents.map((event, i) => `
                        <div class="timeline-item ${event.action_taken ? 'success' : 'warning'}">
                            <div class="timeline-dot"></div>
                            <div class="timeline-content">
                                <div class="timeline-time">${new Date(event.timestamp).toLocaleString()}</div>
                                <div class="timeline-text">
                                    <strong>${event.action_taken ? '✅ SWITCHED' : '⏭️ DISMISSED'}</strong> from <code>${event.from_vm}</code> to <code>${event.to_vm}</code>
                                    <br/>CPU: ${event.cpu_usage_at_event} | Memory: ${event.memory_usage_at_event}
                                    <br/><small>${event.reason}</small>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Event Log Table
        const eventLogBody = document.getElementById("event-log-body");
        if (autoscaleEvents.length === 0) {
            eventLogBody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; color: var(--text-muted);">No events recorded</td>
                </tr>
            `;
        } else {
            eventLogBody.innerHTML = autoscaleEvents.map((event) => `
                <tr>
                    <td>${new Date(event.timestamp).toLocaleString()}</td>
                    <td><strong>${event.action_taken ? '✅ Autoscale' : '⏭️ Alert Dismissed'}</strong></td>
                    <td><code>${event.from_vm}</code></td>
                    <td><code>${event.to_vm}</code></td>
                    <td><span style="color: var(--amber);">${event.cpu_usage_at_event}</span></td>
                    <td><span style="color: var(--green);">${event.memory_usage_at_event}</span></td>
                    <td>${event.acknowledged ? '✅ Acknowledged' : '⏳ Pending'}</td>
                </tr>
            `).join('');
        }

    } catch (e) {
        console.error("Capacity report error:", e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD ACKNOWLEDGEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function loadAcknowledgements() {
    const ackContainer = document.getElementById("ack-container");
    const ackHistory = document.getElementById("ack-history");

    try {
        const res = await fetch(BACKEND_URL + "/autoscale-status");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        if (data.has_pending_acknowledgement && data.pending) {
            ackContainer.innerHTML = `
                <div class="card" style="margin: 20px 0; border-color: var(--red); background: linear-gradient(135deg, rgba(255, 77, 109, 0.15), var(--surface-alt));">
                    <div style="display: flex; align-items: flex-start; gap: 16px;">
                        <div style="font-size: 32px;">⚡</div>
                        <div style="flex: 1;">
                            <div style="font-size: 16px; color: var(--red); font-weight: 700; margin-bottom: 8px;">PENDING AUTOSCALE ACKNOWLEDGEMENT</div>
                            <div style="color: var(--text-secondary); margin-bottom: 12px;">
                                <div>CPU: <strong>${pct(data.cpu_usage)}</strong></div>
                                <div>Memory: <strong>${pct(data.memory_usage)}</strong></div>
                                <div>Switching to: <strong>${data.new_vm_id}</strong></div>
                            </div>
                            <div style="display: flex; gap: 12px;">
                                <button class="btn btn-success" onclick="acknowledgeAutoscale('proceed')" style="flex: 0.5;">✓ PROCEED</button>
                                <button class="btn btn-danger" onclick="acknowledgeAutoscale('dismiss')" style="flex: 0.5;">✕ DISMISS</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            ackContainer.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 60px 20px;">
                    <p style="font-size: 18px; margin-bottom: 10px;">✓ No Pending Acknowledgements</p>
                    <p>System is operating normally</p>
                </div>
            `;
        }

        // History
        if (autoscaleHistory.length === 0) {
            ackHistory.innerHTML = `<p>No acknowledgement history yet</p>`;
        } else {
            ackHistory.innerHTML = `
                <div class="timeline" style="margin: 20px 0;">
                    ${autoscaleHistory.map((item) => `
                        <div class="timeline-item ${item.action === 'proceed' ? 'success' : 'warning'}">
                            <div class="timeline-dot"></div>
                            <div class="timeline-content">
                                <div class="timeline-time">${new Date(item.timestamp).toLocaleString()}</div>
                                <div class="timeline-text">
                                    <strong>${item.action === 'proceed' ? '✅ APPROVED' : '⏭️ DISMISSED'}</strong>
                                    <br/>CPU: ${pct(item.cpu)} | Memory: ${pct(item.memory)}
                                    <br/>Target VM: <code>${item.newVm}</code>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

    } catch (e) {
        console.error("Acknowledgements load error:", e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD VM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function loadVMManagement() {
    try {
        const res = await fetch(BACKEND_URL + "/autoscale-status");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const vmListContainer = document.getElementById("vm-list-container");
        const vmTableBody = document.getElementById("vm-table-body");

        if (!data.all_vms || data.all_vms.length === 0) {
            vmListContainer.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 40px 20px;">
                    <p>No VMs found</p>
                </div>
            `;
            vmTableBody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; color: var(--text-muted);">Loading VM data...</td>
                </tr>
            `;
            return;
        }

        // VM Cards
        vmListContainer.innerHTML = data.all_vms.map(vm => `
            <div class="vm-box ${vm.is_current ? 'active' : 'inactive'}">
                <div class="vm-header">
                    <div class="vm-id">${vm.vm_id}</div>
                    <div>
                        <span style="margin-right: 12px; font-size: 12px; color: var(--text-secondary);">
                            ${vm.ip}
                        </span>
                        <span class="vm-status-badge ${vm.status !== 'running' ? 'stopped' : ''}">
                            ${vm.is_current ? '🟢 ACTIVE' : '⏹️ ' + vm.status.toUpperCase()}
                        </span>
                    </div>
                </div>
                <div class="vm-metrics">
                    <div class="vm-metric">
                        <div class="vm-metric-label">CPU Usage</div>
                        <div class="vm-metric-value">${vm.cpu}</div>
                    </div>
                    <div class="vm-metric">
                        <div class="vm-metric-label">Memory Usage</div>
                        <div class="vm-metric-value">${vm.memory}</div>
                    </div>
                </div>
            </div>
        `).join('');

        // VM Table
        vmTableBody.innerHTML = data.all_vms.map(vm => `
            <tr>
                <td><code>${vm.vm_id}</code></td>
                <td><code>${vm.ip}</code></td>
                <td>${vm.is_current ? '🟢 RUNNING (Current)' : vm.status === 'running' ? '🟢 RUNNING' : '⏹️ STOPPED'}</td>
                <td><strong>${vm.cpu}</strong></td>
                <td><strong>${vm.memory}</strong></td>
                <td>us-central1</td>
                <td>-</td>
            </tr>
        `).join('');

    } catch (e) {
        console.error("VM management load error:", e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DATA LOAD
// ═══════════════════════════════════════════════════════════════════════════════

async function loadData() {
    try {
        const res = await fetch(BACKEND_URL + "/metrics");
        if (!res.ok) throw new Error("HTTP " + res.status);

        const data = await res.json();
        const { cpu = [], memory = [], timestamps = [] } = data;

        // Slice to MAX_POINTS
        const cpuSlice = cpu.slice(0, MAX_POINTS);
        const memSlice = memory.slice(0, MAX_POINTS);
        const tsSlice = timestamps.slice(0, MAX_POINTS);

        // Build readable labels
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

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener("DOMContentLoaded", () => {
    loadData();
    checkAutoscaleStatus();

    // Set up intervals
    setInterval(loadData, REFRESH_MS);
    setInterval(checkAutoscaleStatus, 5000);
});

// Make functions globally available
window.switchTab = switchTab;
window.closeAlertBanner = closeAlertBanner;
window.acknowledgeAutoscale = acknowledgeAutoscale;
window.loadCapacityReport = loadCapacityReport;
window.loadAcknowledgements = loadAcknowledgements;
window.loadVMManagement = loadVMManagement;
window.pct = pct;

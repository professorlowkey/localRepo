// ================= World clocks =================
const CITIES = [
  { city: "New York",    country: "United States",  tz: "America/New_York" },
  { city: "London",      country: "United Kingdom", tz: "Europe/London" },
  { city: "Paris",       country: "France",         tz: "Europe/Paris" },
  { city: "Dubai",       country: "UAE",            tz: "Asia/Dubai" },
  { city: "New Delhi",   country: "India",          tz: "Asia/Kolkata" },
  { city: "Singapore",   country: "Singapore",      tz: "Asia/Singapore" },
  { city: "Tokyo",       country: "Japan",          tz: "Asia/Tokyo" },
  { city: "Sydney",      country: "Australia",      tz: "Australia/Sydney" },
  { city: "Los Angeles", country: "United States",  tz: "America/Los_Angeles" },
  { city: "São Paulo",   country: "Brazil",         tz: "America/Sao_Paulo" },
  { city: "Moscow",      country: "Russia",         tz: "Europe/Moscow" },
  { city: "Cairo",       country: "Egypt",          tz: "Africa/Cairo" },
];

const grid = document.getElementById("clock-grid");
const formatToggle = document.getElementById("format-toggle");
const localTimeEl = document.getElementById("local-time");
const localDateEl = document.getElementById("local-date");

// Build cards once
grid.innerHTML = CITIES.map((c, i) => `
  <article class="clock-card" data-i="${i}">
    <div class="card-top">
      <div>
        <h2 class="city">${c.city}</h2>
        <p class="country">${c.country}</p>
      </div>
      <span class="badge"></span>
    </div>
    <div class="card-body">
      <div class="analog">
        <div class="hand h"></div>
        <div class="hand m"></div>
        <div class="hand s"></div>
      </div>
      <div class="digital"></div>
    </div>
    <div class="card-foot">
      <span class="date"></span>
      <span class="offset"></span>
    </div>
  </article>
`).join("");

const cards = [...grid.children];

// Get h/m/s/date parts for a given timezone
function partsIn(tz, now) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", month: "short", day: "numeric",
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  return {
    h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second),
    date: `${p.weekday}, ${p.month} ${p.day}`,
  };
}

// Difference in hours between a timezone and the user's local time
function offsetFromLocal(tz, now) {
  const there = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const here = new Date(now.toLocaleString("en-US"));
  const diff = Math.round((there - here) / 36e5 * 2) / 2; // nearest half hour
  if (diff === 0) return "Same as you";
  return `${diff > 0 ? "+" : ""}${diff}h from you`;
}

const pad = n => String(n).padStart(2, "0");

function formatTime(h, m, s, use24) {
  if (use24) return { text: `${pad(h)}:${pad(m)}:${pad(s)}`, suffix: "" };
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return { text: `${pad(h12)}:${pad(m)}:${pad(s)}`, suffix };
}

function tickClocks() {
  const now = new Date();
  const use24 = formatToggle.checked;

  // Local hero
  const lt = formatTime(now.getHours(), now.getMinutes(), now.getSeconds(), use24);
  localTimeEl.textContent = lt.text + (lt.suffix ? " " + lt.suffix : "");
  localDateEl.textContent = now.toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // City cards
  CITIES.forEach((c, i) => {
    const card = cards[i];
    const { h, m, s, date } = partsIn(c.tz, now);
    const t = formatTime(h, m, s, use24);

    card.querySelector(".digital").innerHTML =
      t.text + (t.suffix ? `<span class="ampm">${t.suffix}</span>` : "");
    card.querySelector(".date").textContent = date;
    card.querySelector(".offset").textContent = offsetFromLocal(c.tz, now);

    const isDay = h >= 6 && h < 18;
    const badge = card.querySelector(".badge");
    badge.className = `badge ${isDay ? "day" : "night"}`;
    badge.textContent = isDay ? "☀ Day" : "☾ Night";

    // Analog hands
    card.querySelector(".hand.h").style.transform = `rotate(${(h % 12) * 30 + m * 0.5}deg)`;
    card.querySelector(".hand.m").style.transform = `rotate(${m * 6 + s * 0.1}deg)`;
    card.querySelector(".hand.s").style.transform = `rotate(${s * 6}deg)`;
  });
}

formatToggle.addEventListener("change", tickClocks);
tickClocks();
setInterval(tickClocks, 1000);

// ================= Tabs =================
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
  });
});

// ================= Stopwatch =================
const display = document.getElementById("sw-display");
const startBtn = document.getElementById("sw-start");
const lapBtn = document.getElementById("sw-lap");
const resetBtn = document.getElementById("sw-reset");
const lapsList = document.getElementById("laps-list");
const lapsEmpty = document.getElementById("laps-empty");

let running = false;
let startTime = 0;   // performance.now() when last started
let elapsed = 0;     // ms accumulated before the current run
let rafId = null;
let laps = [];       // array of total-elapsed ms at each lap

function fmtSW(ms, withSpan = false) {
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  const main = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return withSpan ? `${main}<span class="ms">.${pad(cs)}</span>` : `${main}.${pad(cs)}`;
}

const currentElapsed = () => elapsed + (running ? performance.now() - startTime : 0);

function render() {
  display.innerHTML = fmtSW(currentElapsed(), true);
  if (running) rafId = requestAnimationFrame(render);
}

function renderLaps() {
  lapsEmpty.style.display = laps.length ? "none" : "block";
  const splits = laps.map((t, i) => t - (laps[i - 1] || 0));
  const min = Math.min(...splits), max = Math.max(...splits);

  lapsList.innerHTML = splits.map((split, i) => {
    let cls = "";
    if (splits.length > 1 && split === min) cls = "fastest";
    if (splits.length > 1 && split === max) cls = "slowest";
    return `<li class="${cls}"><span>#${i + 1}</span><span>${fmtSW(split)}</span><span>${fmtSW(laps[i])}</span></li>`;
  }).reverse().join("");
}

startBtn.addEventListener("click", () => {
  if (running) {
    elapsed += performance.now() - startTime;
    running = false;
    cancelAnimationFrame(rafId);
    startBtn.textContent = "Resume";
    startBtn.classList.remove("stop");
    display.classList.remove("running");
    lapBtn.disabled = true;
  } else {
    startTime = performance.now();
    running = true;
    startBtn.textContent = "Stop";
    startBtn.classList.add("stop");
    display.classList.add("running");
    lapBtn.disabled = false;
    resetBtn.disabled = false;
    render();
  }
});

lapBtn.addEventListener("click", () => {
  laps.push(currentElapsed());
  renderLaps();
});

resetBtn.addEventListener("click", () => {
  running = false;
  cancelAnimationFrame(rafId);
  elapsed = 0;
  laps = [];
  startBtn.textContent = "Start";
  startBtn.classList.remove("stop");
  display.classList.remove("running");
  lapBtn.disabled = true;
  resetBtn.disabled = true;
  render();
  renderLaps();
});

renderLaps();

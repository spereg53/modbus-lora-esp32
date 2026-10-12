(() => {
  "use strict";

  /* ---------------- config / storage ---------------- */
  const LS_URL = "ha_dash_url";
  const LS_TOKEN = "ha_dash_token";
  const REFRESH_MS = 30000;
  const PAGE_SIZE = 60;

  let HA_URL = localStorage.getItem(LS_URL) || window.location.origin;
  let HA_TOKEN = localStorage.getItem(LS_TOKEN) || "";

  /* ---------------- dom refs ---------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    connDot: $("connDot"),
    clock: $("clock"),
    updated: $("updated"),
    refreshBtn: $("refreshBtn"),
    settingsBtn: $("settingsBtn"),
    weatherFx: $("weatherFx"),
    nightVeil: $("nightVeil"),
    weatherIcon: $("weatherIcon"),
    heroTemp: $("heroTemp"),
    heroCond: $("heroCond"),
    heroPlace: $("heroPlace"),
    heroDetails: $("heroDetails"),
    stats: $("stats"),
    search: $("search"),
    chips: $("chips"),
    grid: $("grid"),
    emptyMsg: $("emptyMsg"),
    footInfo: $("footInfo"),
    modal: $("configModal"),
    cfgUrl: $("cfgUrl"),
    cfgToken: $("cfgToken"),
    cfgSave: $("cfgSave"),
    cfgCancel: $("cfgCancel"),
    cfgError: $("cfgError"),
  };

  /* ---------------- icons ---------------- */
  const ICONS = {
    light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.4.3.6.8.6 1.3V16h6v-.9c0-.5.2-1 .6-1.3A6 6 0 0 0 12 3Z"/></svg>`,
    switch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2.6" fill="currentColor" stroke="none"/></svg>`,
    climate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v10.5"/><circle cx="12" cy="17" r="3"/><path d="M12 17V3"/></svg>`,
    sensor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h3l2-6 4 12 2-8 2 4h5"/></svg>`,
    binary_sensor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/></svg>`,
    media_player: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 9.5v5l4-2.5-4-2.5Z" fill="currentColor" stroke="none"/></svg>`,
    cover: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 14h18"/></svg>`,
    fan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 12c0-3 2-6 5-6s3 4-1 5m-4 1c3 0 6 2 6 5s-4 3-5-1m-1-4c-3 0-6-2-6-5s4-3 5 1m1 4c0 3-2 6-5 6s-3-4 1-5"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>`,
    person: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c1.5-4 5-5.5 7.5-5.5s6 1.5 7.5 5.5"/></svg>`,
    device_tracker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>`,
    scene: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 18h16M6 18l3-10 3 6 2-4 2 8"/></svg>`,
    script: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h9l3 3v15H6z"/><path d="M9 11h6M9 15h6"/></svg>`,
    default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`,
  };
  const iconFor = (domain) => ICONS[domain] || ICONS.default;

  const WEATHER_ICONS = {
    sunny: `<svg viewBox="0 0 24 24" fill="none" stroke="#ffd166" stroke-width="1.6"><circle cx="12" cy="12" r="5" fill="#ffd166" stroke="none"/><g stroke="#ffd166"><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></g></svg>`,
    "clear-night": `<svg viewBox="0 0 24 24" fill="#9fb4ff" stroke="none"><path d="M14 2a9 9 0 1 0 8 13 8 8 0 0 1-8-13Z"/></svg>`,
    partlycloudy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="10" r="4" fill="#ffd166" stroke="none"/><path d="M8 17h9a4 4 0 0 0 0-8 5 5 0 0 0-9.2-2" fill="#e8edf0" stroke="none"/></svg>`,
    cloudy: `<svg viewBox="0 0 24 24" fill="#e8edf0" stroke="none"><path d="M6 18h12a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.3-2A5 5 0 0 0 6 18Z"/></svg>`,
    fog: `<svg viewBox="0 0 24 24" fill="none" stroke="#eef0f1" stroke-width="1.8"><path d="M4 9h12M3 13h16M5 17h14"/></svg>`,
    windy: `<svg viewBox="0 0 24 24" fill="none" stroke="#dff2f1" stroke-width="1.8"><path d="M3 8h11a2.5 2.5 0 1 0-2-4M3 13h15a2.5 2.5 0 1 1-2 4M3 18h9"/></svg>`,
    "windy-variant": `<svg viewBox="0 0 24 24" fill="none" stroke="#dff2f1" stroke-width="1.8"><path d="M3 8h11a2.5 2.5 0 1 0-2-4M3 13h15a2.5 2.5 0 1 1-2 4M3 18h9"/></svg>`,
    rainy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 15h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 15Z" fill="#c7d6e0" stroke="none"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" stroke="#9fd3ff"/></svg>`,
    pouring: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 14h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 14Z" fill="#9fb3c2" stroke="none"/><path d="M7 17l-1.5 4M11 17l-1.5 4M15 17l-1.5 4M19 17l-1.5 4" stroke="#8fc9ff"/></svg>`,
    lightning: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 14h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 14Z" fill="#9aa3b2"/><path d="M13 13l-3 5h2.5l-1.5 4 4-5.5h-2.5l1.5-3.5Z" fill="#ffe066"/></svg>`,
    "lightning-rainy": `<svg viewBox="0 0 24 24" fill="none"><path d="M6 13h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 13Z" fill="#8a94a3"/><path d="M12 12l-2.6 4.3h2.1L10.3 20l3.5-4.8h-2.1l1.3-3Z" fill="#ffe066"/><path d="M6 17l-1 3" stroke="#9fd3ff" stroke-width="1.6"/></svg>`,
    snowy: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 13h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 13Z" fill="#c7d6e0"/><g fill="#fff"><circle cx="8" cy="18" r="1.1"/><circle cx="12" cy="20" r="1.1"/><circle cx="16" cy="18" r="1.1"/></g></svg>`,
    "snowy-rainy": `<svg viewBox="0 0 24 24" fill="none"><path d="M6 13h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 13Z" fill="#aebccb"/><g fill="#fff"><circle cx="8" cy="18" r="1"/><circle cx="16" cy="18" r="1"/></g><path d="M12 17l-1 4" stroke="#9fd3ff" stroke-width="1.6"/></svg>`,
    hail: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 13h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4-1.6A4.5 4.5 0 0 0 6 13Z" fill="#c7d6e0"/><g fill="#dfe9f2"><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></g></svg>`,
    exceptional: `<svg viewBox="0 0 24 24" fill="none" stroke="#ffd1f0" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>`,
  };

  const WEATHER_LABEL = {
    sunny: "Soleado",
    "clear-night": "Despejado",
    partlycloudy: "Parcialmente nublado",
    cloudy: "Nublado",
    fog: "Niebla",
    windy: "Viento",
    "windy-variant": "Viento y nubes",
    rainy: "Lluvia",
    pouring: "Lluvia intensa",
    lightning: "Tormenta eléctrica",
    "lightning-rainy": "Tormenta con lluvia",
    snowy: "Nieve",
    "snowy-rainy": "Aguanieve",
    hail: "Granizo",
    exceptional: "Excepcional",
  };

  /* ---------------- domain metadata ---------------- */
  const DOMAIN_META = {
    light: { label: "Luces", onStates: ["on"] },
    switch: { label: "Interruptores", onStates: ["on"] },
    climate: { label: "Clima", onStates: ["heat", "cool", "heat_cool", "auto", "dry", "fan_only"] },
    media_player: { label: "Multimedia", onStates: ["playing"] },
    cover: { label: "Cubiertas", onStates: ["open", "opening"] },
    fan: { label: "Ventiladores", onStates: ["on"] },
    lock: { label: "Cerraduras", onStates: ["unlocked"] },
    binary_sensor: { label: "Sensores binarios", onStates: ["on"] },
    sensor: { label: "Sensores", onStates: [] },
    person: { label: "Personas", onStates: ["home"] },
    device_tracker: { label: "Rastreadores", onStates: ["home"] },
    scene: { label: "Escenas", onStates: [] },
    script: { label: "Scripts", onStates: ["on"] },
    automation: { label: "Automatizaciones", onStates: ["on"] },
    siren: { label: "Sirenas", onStates: ["on"] },
    input_boolean: { label: "Booleanos", onStates: ["on"] },
    button: { label: "Botones", onStates: [] },
    input_button: { label: "Botones", onStates: [] },
  };
  const OTHER_LABEL = "Otros";

  // Dominios internos/ruido que no aportan nada en un dashboard táctil
  const EXCLUDED_DOMAINS = new Set([
    "zone", "automation", "update", "tag", "persistent_notification",
    "conversation", "stt", "tts", "assist_satellite", "schedule",
    "calendar", "counter", "timer", "image", "weather", "sun",
  ]);

  // Plantilla Jinja (vía /api/template) para obtener área + visibilidad real
  // de cada entidad; no existe en la REST API normal, solo por template.
  // No se puede usar dict.update() (el sandbox de HA lo bloquea), así que
  // se arma un array JSON entidad por entidad con tojson.
  const AREA_TEMPLATE = `[
{% for s in states %}
{"id": {{ s.entity_id | tojson }}, "area": {{ (area_name(s.entity_id) or "") | tojson }}, "hidden": {{ is_hidden_entity(s.entity_id) | tojson }}}{% if not loop.last %},{% endif %}
{% endfor %}
]`;

  function slugify(str) {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const TOGGLE_RULES = {
    light: () => ({ service: "toggle" }),
    switch: () => ({ service: "toggle" }),
    fan: () => ({ service: "toggle" }),
    siren: () => ({ service: "toggle" }),
    input_boolean: () => ({ service: "toggle" }),
    lock: (state) => ({ service: state === "locked" ? "unlock" : "lock" }),
    cover: (state) => ({ service: state === "closed" ? "open_cover" : "close_cover" }),
    scene: () => ({ service: "turn_on" }),
    script: () => ({ service: "turn_on" }),
    button: () => ({ service: "press" }),
    input_button: () => ({ service: "press" }),
  };

  const CHIP_DEFS = [
    { id: "active", label: "Activos ahora" },
    { id: "light", label: "Luces" },
    { id: "switch", label: "Interruptores" },
    { id: "climate", label: "Clima" },
    { id: "media_player", label: "Multimedia" },
    { id: "cover", label: "Cubiertas" },
    { id: "fan", label: "Ventiladores" },
    { id: "lock", label: "Cerraduras" },
    { id: "binary_sensor", label: "Sensores binarios" },
    { id: "sensor", label: "Sensores" },
    { id: "person", label: "Personas" },
    { id: "all", label: "Todo" },
  ];

  /* ---------------- state ---------------- */
  let allStates = [];
  let currentChip = "active";
  let searchTerm = "";
  let pageLimit = PAGE_SIZE;
  let fxBuilt = null; // last weather category we built fx for
  let AREA_INFO = {}; // entity_id -> { area, hidden }
  let areaModeActive = false;
  let activeChipDefs = CHIP_DEFS;
  let refreshTimer = null;

  /* ---------------- HA client ---------------- */
  async function haFetch(path, opts = {}) {
    const res = await fetch(HA_URL.replace(/\/$/, "") + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HA ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function fetchStates() {
    return haFetch("/api/states");
  }

  // El área y la visibilidad real de una entidad no están en /api/states
  // (son del registro de entidades), solo accesibles vía /api/template.
  // Si la instalación de HA no tiene is_hidden_entity/area_name (versiones
  // viejas), esto falla y seguimos con los chips por tipo de siempre.
  async function fetchAreaInfo() {
    const res = await fetch(HA_URL.replace(/\/$/, "") + "/api/template", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ template: AREA_TEMPLATE }),
    });
    if (!res.ok) throw new Error(`template ${res.status}`);
    const arr = JSON.parse(await res.text());
    const map = {};
    arr.forEach((x) => {
      map[x.id] = { area: x.area, hidden: x.hidden };
    });
    return map;
  }

  function buildChipDefs() {
    if (!areaModeActive) {
      activeChipDefs = CHIP_DEFS;
      return;
    }
    const areaNames = new Set();
    Object.values(AREA_INFO).forEach((info) => {
      if (info && info.area) areaNames.add(info.area);
    });
    const sorted = Array.from(areaNames).sort((a, b) => a.localeCompare(b, "es"));
    activeChipDefs = [
      { id: "active", label: "Activos ahora" },
      ...sorted.map((name) => ({ id: slugify(name), label: name })),
      { id: "sin-area", label: "Sin área" },
      { id: "all", label: "Todo" },
    ];
  }

  async function callService(domain, service, entityId) {
    return haFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId }),
    });
  }

  /* ---------------- config modal ---------------- */
  function showConfig(forceShow) {
    el.cfgUrl.value = HA_URL || window.location.origin;
    el.cfgToken.value = "";
    el.cfgError.hidden = true;
    el.modal.hidden = false;
  }
  function hideConfig() {
    el.modal.hidden = true;
  }
  el.settingsBtn.addEventListener("click", () => showConfig(true));
  el.cfgCancel.addEventListener("click", () => {
    if (HA_TOKEN) hideConfig();
  });
  el.cfgSave.addEventListener("click", async () => {
    const url = el.cfgUrl.value.trim().replace(/\/$/, "");
    const token = el.cfgToken.value.trim();
    if (!url || !token) {
      el.cfgError.textContent = "Completa la URL y el token.";
      el.cfgError.hidden = false;
      return;
    }
    const prevUrl = HA_URL, prevToken = HA_TOKEN;
    HA_URL = url;
    HA_TOKEN = token;
    try {
      await fetchStates();
      localStorage.setItem(LS_URL, HA_URL);
      localStorage.setItem(LS_TOKEN, HA_TOKEN);
      hideConfig();
      boot();
    } catch (e) {
      HA_URL = prevUrl;
      HA_TOKEN = prevToken;
      el.cfgError.textContent = "No se pudo conectar. Revisa la URL y el token.";
      el.cfgError.hidden = false;
    }
  });

  /* ---------------- clock ---------------- */
  function tickClock() {
    const now = new Date();
    el.clock.textContent = now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  }
  setInterval(tickClock, 1000);
  tickClock();

  /* ---------------- weather fx ---------------- */
  function categoryFor(condition) {
    if (["sunny"].includes(condition)) return "sun";
    if (["clear-night"].includes(condition)) return "night";
    if (["partlycloudy"].includes(condition)) return "partly";
    if (["cloudy", "windy", "windy-variant", "exceptional"].includes(condition)) return "cloud";
    if (["fog"].includes(condition)) return "fog";
    if (["rainy", "pouring"].includes(condition)) return "rain";
    if (["lightning", "lightning-rainy"].includes(condition)) return "storm";
    if (["snowy", "snowy-rainy", "hail"].includes(condition)) return "snow";
    return "cloud";
  }

  function buildFx(category) {
    if (fxBuilt === category) return;
    fxBuilt = category;
    el.weatherFx.innerHTML = "";

    const rand = (a, b) => a + Math.random() * (b - a);

    if (category === "sun" || category === "partly") {
      const sun = document.createElement("div");
      sun.className = "fx-sun";
      el.weatherFx.appendChild(sun);
    }
    if (category === "night") {
      for (let i = 0; i < 40; i++) {
        const s = document.createElement("div");
        s.className = "fx-star";
        s.style.left = rand(0, 100) + "vw";
        s.style.top = rand(0, 60) + "vh";
        s.style.animationDelay = rand(0, 3) + "s";
        el.weatherFx.appendChild(s);
      }
    }
    if (category === "partly" || category === "cloud" || category === "storm") {
      const n = category === "cloud" ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const c = document.createElement("div");
        c.className = "fx-cloud";
        const w = rand(120, 260);
        c.style.width = w + "px";
        c.style.height = w * 0.4 + "px";
        c.style.top = rand(5, 50) + "vh";
        c.style.animationDuration = rand(35, 70) + "s";
        c.style.animationDelay = rand(-30, 0) + "s";
        el.weatherFx.appendChild(c);
      }
    }
    if (category === "fog") {
      for (let i = 0; i < 6; i++) {
        const f = document.createElement("div");
        f.className = "fx-fog";
        f.style.top = rand(10, 85) + "vh";
        f.style.opacity = rand(0.3, 0.7);
        f.style.animationDuration = rand(18, 34) + "s";
        f.style.animationDelay = rand(-20, 0) + "s";
        el.weatherFx.appendChild(f);
      }
    }
    if (category === "rain" || category === "storm") {
      const n = 60;
      for (let i = 0; i < n; i++) {
        const d = document.createElement("div");
        d.className = "fx-drop";
        d.style.left = rand(0, 100) + "vw";
        d.style.animationDuration = rand(0.5, 1.1) + "s";
        d.style.animationDelay = rand(-2, 0) + "s";
        d.style.opacity = rand(0.4, 1);
        el.weatherFx.appendChild(d);
      }
    }
    if (category === "snow") {
      const n = 50;
      for (let i = 0; i < n; i++) {
        const f = document.createElement("div");
        f.className = "fx-flake";
        const size = rand(3, 7);
        f.style.width = size + "px";
        f.style.height = size + "px";
        f.style.left = rand(0, 100) + "vw";
        f.style.animationDuration = rand(6, 14) + "s";
        f.style.animationDelay = rand(-10, 0) + "s";
        f.style.opacity = rand(0.5, 1);
        el.weatherFx.appendChild(f);
      }
    }
    if (category === "storm") {
      const flash = document.createElement("div");
      flash.className = "fx-flash";
      flash.id = "fxFlash";
      el.weatherFx.appendChild(flash);
      scheduleLightning();
    }
  }

  let lightningTimer = null;
  function scheduleLightning() {
    if (lightningTimer) clearTimeout(lightningTimer);
    const next = 3000 + Math.random() * 7000;
    lightningTimer = setTimeout(() => {
      const f = $("fxFlash");
      if (f) {
        f.classList.remove("hit");
        void f.offsetWidth;
        f.classList.add("hit");
      }
      if (fxBuilt === "storm") scheduleLightning();
    }, next);
  }

  /* ---------------- hero / weather render ---------------- */
  function renderWeather(states) {
    const weatherEntity = states.find((e) => e.entity_id.startsWith("weather."));
    const sunEntity = states.find((e) => e.entity_id === "sun.sun");

    let condition = weatherEntity ? weatherEntity.state : "cloudy";
    const isNight = sunEntity && sunEntity.state === "below_horizon";
    if (isNight && condition === "sunny") condition = "clear-night";
    if (isNight && condition === "partlycloudy") condition = "cloudy";

    el.body.setAttribute("data-weather", condition);
    buildFx(categoryFor(condition));
    el.nightVeil.classList.toggle("on", !!isNight && categoryFor(condition) !== "night");

    el.weatherIcon.innerHTML = WEATHER_ICONS[condition] || WEATHER_ICONS.cloudy;
    el.heroCond.textContent = WEATHER_LABEL[condition] || condition;

    if (weatherEntity) {
      const a = weatherEntity.attributes || {};
      const unit = a.temperature_unit || "°C";
      el.heroTemp.textContent = a.temperature != null ? `${Math.round(a.temperature)}°` : "--°";
      el.heroPlace.textContent = weatherEntity.attributes.friendly_name || "";

      const details = [];
      if (a.humidity != null) details.push({ v: `${a.humidity}%`, l: "Humedad" });
      if (a.wind_speed != null) details.push({ v: `${Math.round(a.wind_speed)} ${a.wind_speed_unit || "km/h"}`, l: "Viento" });
      if (a.pressure != null) details.push({ v: `${Math.round(a.pressure)} ${a.pressure_unit || "hPa"}`, l: "Presión" });
      if (a.visibility != null) details.push({ v: `${a.visibility} ${a.visibility_unit || "km"}`, l: "Visibilidad" });
      el.heroDetails.innerHTML = details
        .map((d) => `<div><span class="v">${d.v}</span>${d.l}</div>`)
        .join("");
    } else {
      el.heroTemp.textContent = "--°";
      el.heroPlace.textContent = "Sin entidad de clima";
      el.heroDetails.innerHTML = "";
    }
  }

  /* ---------------- stats ---------------- */
  function isOn(entity, domain) {
    const meta = DOMAIN_META[domain];
    if (!meta || !meta.onStates.length) return false;
    return meta.onStates.includes(entity.state);
  }

  function renderStats(states) {
    const counts = {};
    for (const e of states) {
      const domain = e.entity_id.split(".")[0];
      if (isOn(e, domain)) counts[domain] = (counts[domain] || 0) + 1;
    }
    const tiles = [
      { domain: "light", label: "Luces encendidas" },
      { domain: "switch", label: "Interruptores activos" },
      { domain: "climate", label: "Clima activo" },
      { domain: "media_player", label: "Reproduciendo" },
      { domain: "cover", label: "Cubiertas abiertas" },
      { domain: "fan", label: "Ventiladores on" },
      { domain: "lock", label: "Sin asegurar" },
      { domain: "binary_sensor", label: "Sensores activados" },
      { domain: "person", label: "En casa" },
    ];
    el.stats.innerHTML = tiles
      .map(
        (t) => `<button class="stat-tile ${currentChip === t.domain ? "active" : ""}" data-chip="${t.domain}">
          <div class="stat-num">${counts[t.domain] || 0}</div>
          <div class="stat-label">${t.label}</div>
        </button>`
      )
      .join("");
    el.stats.querySelectorAll(".stat-tile").forEach((btn) => {
      btn.addEventListener("click", () => setChip(btn.dataset.chip));
    });
  }

  /* ---------------- chips / search ---------------- */
  function renderChips() {
    el.chips.innerHTML = activeChipDefs.map(
      (c) => `<button class="chip ${currentChip === c.id ? "active" : ""}" data-chip="${c.id}">${c.label}</button>`
    ).join("");
    el.chips.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => setChip(btn.dataset.chip));
    });
  }
  function setChip(id) {
    currentChip = id;
    pageLimit = PAGE_SIZE;
    renderChips();
    renderGrid(allStates);
  }
  el.search.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    pageLimit = PAGE_SIZE;
    renderGrid(allStates);
  });

  /* ---------------- grid ---------------- */
  function areaSlugFor(entity) {
    const info = AREA_INFO[entity.entity_id];
    return info && info.area ? slugify(info.area) : "sin-area";
  }

  function matchesChip(entity, domain) {
    if (currentChip === "all") return true;
    if (currentChip === "active") return isOn(entity, domain);
    if (currentChip === domain) return true; // atajo desde las tarjetas de stats
    if (areaModeActive) return areaSlugFor(entity) === currentChip;
    return false;
  }

  function friendlyName(e) {
    return (e.attributes && e.attributes.friendly_name) || e.entity_id;
  }

  function cardHtml(e) {
    const domain = e.entity_id.split(".")[0];
    const name = friendlyName(e);
    const on = isOn(e, domain);
    let stateText = e.state;
    if (domain === "sensor" || domain === "number") {
      const unit = e.attributes.unit_of_measurement;
      stateText = unit ? `${e.state} ${unit}` : e.state;
    }
    const rule = TOGGLE_RULES[domain];
    const actions = rule
      ? `<div class="card-actions"><button class="mini-btn primary" data-entity="${e.entity_id}" data-domain="${domain}">${
          domain === "lock" ? (e.state === "locked" ? "Abrir" : "Asegurar") : domain === "cover" ? (e.state === "closed" ? "Abrir" : "Cerrar") : "Accionar"
        }</button></div>`
      : "";
    return `<div class="card">
      <div class="card-top">
        <div class="card-icon">${iconFor(domain)}</div>
        <div class="card-name">${name}</div>
      </div>
      <div class="card-state ${on ? "on" : ""}">${stateText}</div>
      ${actions}
    </div>`;
  }

  function renderGrid(states) {
    let list = states.filter((e) => {
      const domain = e.entity_id.split(".")[0];
      if (!matchesChip(e, domain)) return false;
      if (searchTerm) {
        const hay = (friendlyName(e) + " " + e.entity_id).toLowerCase();
        if (!hay.includes(searchTerm)) return false;
      }
      return true;
    });

    list.sort((a, b) => friendlyName(a).localeCompare(friendlyName(b), "es"));

    el.emptyMsg.hidden = list.length > 0;
    const shown = list.slice(0, pageLimit);
    el.grid.innerHTML = shown.map(cardHtml).join("");

    el.grid.querySelectorAll("[data-entity]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.entity;
        const domain = btn.dataset.domain;
        const entity = allStates.find((e) => e.entity_id === entityId);
        const rule = TOGGLE_RULES[domain](entity ? entity.state : "");
        btn.disabled = true;
        try {
          await callService(domain, rule.service, entityId);
          setTimeout(refresh, 500);
        } catch (err) {
          btn.disabled = false;
        }
      });
    });

    if (list.length > pageLimit) {
      const more = document.createElement("button");
      more.className = "mini-btn";
      more.style.gridColumn = "1 / -1";
      more.textContent = `Cargar más (${list.length - pageLimit} restantes)`;
      more.addEventListener("click", () => {
        pageLimit += PAGE_SIZE;
        renderGrid(allStates);
      });
      el.grid.appendChild(more);
    }
  }

  /* ---------------- refresh cycle ---------------- */
  async function refresh() {
    try {
      const raw = await fetchStates();
      renderWeather(raw); // necesita weather.*/sun.sun, que luego se filtran

      const states = raw.filter((e) => {
        const domain = e.entity_id.split(".")[0];
        if (EXCLUDED_DOMAINS.has(domain)) return false;
        const info = AREA_INFO[e.entity_id];
        if (info && info.hidden) return false;
        return true;
      });
      allStates = states;
      renderStats(states);
      renderGrid(states);
      el.connDot.classList.remove("bad");
      el.connDot.classList.add("ok");
      const now = new Date();
      el.updated.textContent = "Actualizado " + now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      el.footInfo.textContent = `${states.length} entidades · actualiza cada ${REFRESH_MS / 1000}s`;
    } catch (e) {
      el.connDot.classList.remove("ok");
      el.connDot.classList.add("bad");
      if (String(e.message).includes("401")) {
        showConfig(true);
      }
    }
  }
  el.refreshBtn.addEventListener("click", refresh);

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      AREA_INFO = await fetchAreaInfo();
      areaModeActive = true;
    } catch (e) {
      areaModeActive = false;
    }
    buildChipDefs();
    renderChips();
    refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  if (!HA_TOKEN) {
    showConfig(true);
  } else {
    boot();
  }
})();

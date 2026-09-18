(() => {
  const $ = (id) => document.getElementById(id);

  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const lastUpdateEl = $('lastUpdate');
  const rawJsonEl = $('raw-json');

  let lastReceivedAt = null;
  let liveHistory = []; // { fields, deviceTs, receivedAt } — buffer corto (en vivo)
  let kwhInicioHoy = null; // contador de energía al inicio del día (para "consumo hoy")

  // ---------- sección "Último payload": oculta salvo que la URL traiga #raw ----------
  function syncRawSectionVisibility() {
    const show = location.hash.replace('#', '').toLowerCase() === 'raw';
    $('raw-section').hidden = !show;
  }
  syncRawSectionVisibility();
  window.addEventListener('hashchange', syncRawSectionVisibility);

  // ---------- formato de valores ----------
  function grouped(value, decimals) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  function fmtPower(value, unitBase) {
    if (value === undefined || value === null || Number.isNaN(value)) return '--';
    const abs = Math.abs(value);
    if (abs >= 1000) return grouped(value / 1000, 2) + ' k' + unitBase;
    return grouped(value, 1) + ' ' + unitBase;
  }
  function fmtRaw(value, decimals, suffix) {
    if (value === undefined || value === null || Number.isNaN(value)) return '--';
    return grouped(value, decimals) + (suffix || '');
  }

  // ---------- gauges ----------
  const GAUGE_LEN = 157; // longitud aproximada del arco (semicírculo r=50)

  function setGauge(id, frac, color) {
    const el = $('gauge-' + id);
    if (!el) return;
    const clamped = Math.max(0, Math.min(1, frac));
    el.style.strokeDashoffset = String(GAUGE_LEN * (1 - clamped));
    el.style.stroke = color;
  }
  function colorForFrequency(f) {
    if (f === undefined || f === null) return '#8b93a1';
    if (f >= 59.7 && f <= 60.3) return '#3dd68c';
    if (f >= 59.3 && f <= 60.7) return '#f0c14b';
    return '#f0554b';
  }
  function colorForPF(pf) {
    if (pf === undefined || pf === null) return '#8b93a1';
    if (pf >= 0.95) return '#3dd68c';
    if (pf >= 0.85) return '#f0c14b';
    return '#f0554b';
  }

  // ---------- render de la lectura más reciente (tarjetas + gauges) ----------
  function renderReading(reading) {
    if (!reading || !reading.fields) return;
    const f = reading.fields;
    lastReceivedAt = reading.receivedAt || Date.now();

    $('val-frecuencia').textContent = fmtRaw(f.frecuencia, 2, ' Hz');
    setGauge('frecuencia', ((f.frecuencia ?? 60) - 55) / 10, colorForFrequency(f.frecuencia));

    $('val-factorPotencia').textContent = fmtRaw(f.factorPotencia, 3);
    setGauge('factorPotencia', Math.abs(f.factorPotencia ?? 0), colorForPF(Math.abs(f.factorPotencia ?? 0)));

    $('val-potenciaTotal').textContent = fmtPower(f.potenciaTotal, 'W');
    $('val-potenciaApTotal').textContent = fmtPower(f.potenciaApTotal, 'VA');
    $('val-potenciaReacTotal').textContent = fmtPower(f.potenciaReacTotal, 'VAr');

    if (typeof f.energiaActivaTotalKwh === 'number' &&
        f.energiaActivaTotalKwh >= 0 && f.energiaActivaTotalKwh < 1e8) {
      $('val-energiaTotal').textContent = grouped(f.energiaActivaTotalKwh, 1) + ' kWh';
      if (kwhInicioHoy != null) {
        $('val-consumoHoy').textContent =
          grouped(Math.max(0, f.energiaActivaTotalKwh - kwhInicioHoy), 2) + ' kWh';
      }
    }

    $('val-voltaje1').textContent = fmtRaw(f.voltaje1, 1, ' V');
    $('val-voltaje2').textContent = fmtRaw(f.voltaje2, 1, ' V');
    $('val-voltaje3').textContent = fmtRaw(f.voltaje3, 1, ' V');

    $('val-corriente1').textContent = fmtRaw(f.corriente1, 2, ' A');
    $('val-corriente2').textContent = fmtRaw(f.corriente2, 2, ' A');
    $('val-corriente3').textContent = fmtRaw(f.corriente3, 2, ' A');

    $('val-potencia1').textContent = fmtPower(f.potencia1, 'W');
    $('val-potencia2').textContent = fmtPower(f.potencia2, 'W');
    $('val-potencia3').textContent = fmtPower(f.potencia3, 'W');

    rawJsonEl.textContent = JSON.stringify(f, null, 2);

    drawLiveCharts();
  }

  function updateStatusLoop() {
    if (!lastReceivedAt) {
      statusDot.className = 'dot';
      statusText.textContent = 'Sin datos aún';
      lastUpdateEl.textContent = '';
      return;
    }
    const ageSec = (Date.now() - lastReceivedAt) / 1000;
    lastUpdateEl.textContent = 'Última lectura: hace ' + Math.floor(ageSec) + 's';
    // El Walter publica cada 5 min por celular; una publicación perdida es
    // normal. Sólo marcamos "sin datos" pasados 15 min (3 ciclos), que es
    // el mismo umbral al que el firmware se fuerza a reiniciar solo
    // ("hombre muerto" — ver DEADMAN_MS en el firmware).
    if (ageSec < 400) {
      statusDot.className = 'dot live';
      statusText.textContent = 'En vivo';
    } else if (ageSec < 900) {
      statusDot.className = 'dot live';
      statusText.textContent = 'En vivo (última hace ' + Math.floor(ageSec) + 's)';
    } else {
      statusDot.className = 'dot stale';
      statusText.textContent = 'Sin datos recientes';
    }
  }
  setInterval(updateStatusLoop, 1000);

  // ---------- panel de diagnóstico (topic MQTT_TOPIC_DIAG del firmware) ----------
  let lastDiagReceivedAt = null;

  function setDiagDot(id, ok) {
    const el = $(id);
    if (!el) return;
    el.className = 'dot' + (ok === true ? ' live' : ok === false ? '' : ' stale');
  }

  function renderDiag(diag) {
    if (!diag || !diag.fields) return;
    const d = diag.fields;
    lastDiagReceivedAt = diag.receivedAt || Date.now();

    setDiagDot('diag-dot-modbus', d.modbusOK);
    const detallesModbus = [];
    if (d.modbusOK === false) detallesModbus.push((d.modbusErroresSeguidos ?? '?') + ' error(es) seguido(s)');
    if (d.modbusBloque2OK === false) detallesModbus.push('FP/Q sin leer');
    if (d.modbusFrecuenciaOK === false) detallesModbus.push('frecuencia sin leer');
    if (d.modbusEnergiaOK === false) detallesModbus.push('energía sin leer');
    $('diag-detail-modbus').textContent = d.modbusOK
      ? (detallesModbus.length ? 'OK (' + detallesModbus.join(', ') + ')' : 'OK')
      : 'Error leyendo el medidor' + (detallesModbus.length ? ' (' + detallesModbus.join(', ') + ')' : '');

    setDiagDot('diag-dot-red', d.redRegistrada);
    $('diag-detail-red').textContent = d.redRegistrada ? 'Registrado en la red celular' : 'Sin registro de red celular';

    setDiagDot('diag-dot-mqtt', d.fallosMQTTSeguidos === 0);
    const segPub = d.segSinPublishOK;
    $('diag-detail-mqtt').textContent =
      (d.fallosMQTTSeguidos > 0 ? d.fallosMQTTSeguidos + ' publish fallido(s) seguido(s) · ' : '') +
      (typeof segPub === 'number' && segPub >= 0 ? 'último publish OK hace ' + segPub + 's' : 'sin publish OK aún');

    setDiagDot('diag-dot-boot', (d.bootCount ?? 1) <= 1);
    const uptimeMin = Math.floor((d.uptimeS ?? 0) / 60);
    $('diag-detail-boot').textContent =
      (d.bootCount ?? '?') + ' reinicio(s) · último motivo: ' + (d.motivoReinicio || '--') +
      ' · uptime ' + uptimeMin + ' min';
  }

  function updateDiagStatusLoop() {
    const footer = $('diag-lastUpdate');
    if (!footer) return;
    if (!lastDiagReceivedAt) { footer.textContent = 'Diagnóstico: sin datos aún'; return; }
    const ageSec = Math.floor((Date.now() - lastDiagReceivedAt) / 1000);
    // Mismo umbral que el estado principal: si a los 900s no llegó un nuevo
    // diagnóstico, es porque el enlace MQTT mismo está caído (no tiene caso
    // seguir mostrando el último estado como si fuera vigente).
    if (ageSec >= 900) {
      ['diag-dot-modbus', 'diag-dot-red', 'diag-dot-mqtt', 'diag-dot-boot'].forEach((id) => {
        const el = $(id);
        if (el) el.className = 'dot stale';
      });
      footer.textContent = 'Diagnóstico desactualizado (hace ' + ageSec + 's) — revisar enlace';
    } else {
      footer.textContent = 'Diagnóstico actualizado hace ' + ageSec + 's';
    }
  }
  setInterval(updateDiagStatusLoop, 1000);

  // ---------- gráficas de línea (canvas, sin librerías externas) ----------
  // opts.fixedRange = [min, max]  → escala Y fija (evita que el ruido de
  //   señales casi planas como frecuencia o FP se vea amplificado).
  // opts.yTicks    = [...]        → valores concretos a rotular en el eje Y.
  // opts.refLines  = [...]        → líneas de referencia resaltadas.

  // Genera marcas "redondas" (1/2/5·10ⁿ) entre lo y hi.
  function niceTicks(lo, hi, count) {
    const range = hi - lo;
    if (!(range > 0)) return [lo];
    const rawStep = range / (count || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) {
      ticks.push(Number(t.toFixed(10)));
    }
    return ticks;
  }
  function tickDecimals(ticks) {
    let d = 0;
    ticks.forEach((t) => {
      const s = String(t);
      const dot = s.indexOf('.');
      if (dot >= 0) d = Math.max(d, s.length - dot - 1);
    });
    return Math.min(d, 3);
  }

  function drawLineChart(canvas, series, colors, opts) {
    if (!canvas) return;
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 140;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const allValues = series.flat().filter((v) => typeof v === 'number' && !Number.isNaN(v));
    if (allValues.length < 2 && !opts.fixedRange) {
      ctx.fillStyle = '#8b93a1';
      ctx.font = '12px sans-serif';
      ctx.fillText('Esperando más lecturas…', 8, cssH / 2);
      return;
    }

    let yMin, yMax;
    if (opts.fixedRange) {
      yMin = opts.fixedRange[0];
      yMax = opts.fixedRange[1];
    } else {
      const min = Math.min(...allValues);
      const max = Math.max(...allValues);
      const pad = (max - min) * 0.1 || 1;
      yMin = min - pad;
      yMax = max + pad;
    }

    const marginL = 40, marginR = 8, marginT = 8, marginB = 8;
    const w = cssW - marginL - marginR;
    const h = cssH - marginT - marginB;
    const span = yMax - yMin || 1;
    const yOf = (v) => marginT + h - ((v - yMin) / span) * h;

    // ---- eje Y: rejilla + valores ----
    const ticks = (opts.yTicks && opts.yTicks.length ? opts.yTicks : niceTicks(yMin, yMax, 4))
      .filter((t) => t >= yMin - span * 1e-6 && t <= yMax + span * 1e-6);
    const dec = tickDecimals(ticks);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach((t) => {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.strokeStyle = 'rgba(139,147,161,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(marginL, y);
      ctx.lineTo(marginL + w, y);
      ctx.stroke();
      ctx.fillStyle = '#8b93a1';
      ctx.fillText(t.toFixed(dec), marginL - 5, y);
    });

    // ---- líneas de referencia resaltadas ----
    if (Array.isArray(opts.refLines)) {
      ctx.strokeStyle = 'rgba(139,147,161,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      opts.refLines.forEach((rv) => {
        if (rv < yMin || rv > yMax) return;
        const y = yOf(rv);
        ctx.beginPath();
        ctx.moveTo(marginL, y);
        ctx.lineTo(marginL + w, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    // ---- series ----
    series.forEach((values, si) => {
      if (values.length < 2) return;
      ctx.beginPath();
      let started = false;
      values.forEach((v, i) => {
        if (v === null || v === undefined || Number.isNaN(v)) return;
        const x = marginL + (i / (values.length - 1)) * w;
        let y = yOf(v);
        y = Math.max(marginT, Math.min(marginT + h, y)); // recorta al área visible
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = colors[si] || '#4fd1c5';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  // Escalas Y fijas para las magnitudes casi planas
  const FREQ_RANGE = { fixedRange: [59, 61], yTicks: [59, 59.5, 60, 60.5, 61], refLines: [60] };
  const PF_RANGE   = { fixedRange: [0, 1.05], yTicks: [0, 0.25, 0.5, 0.75, 1], refLines: [1] };

  // ---------- gráfica de barras (consumo por día) ----------
  function drawBarChart(canvas, labels, values, color) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 180;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
    if (!nums.length) {
      ctx.fillStyle = '#8b93a1';
      ctx.font = '12px sans-serif';
      ctx.fillText('Sin datos de consumo aún…', 8, cssH / 2);
      return;
    }

    const marginL = 40, marginR = 8, marginT = 10, marginB = 22;
    const w = cssW - marginL - marginR;
    const h = cssH - marginT - marginB;
    const yMax = Math.max(...nums) * 1.15 || 1;

    // eje Y
    const ticks = niceTicks(0, yMax, 4);
    const dec = tickDecimals(ticks);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach((t) => {
      const y = Math.round(marginT + h - (t / yMax) * h) + 0.5;
      ctx.strokeStyle = 'rgba(139,147,161,0.15)';
      ctx.beginPath();
      ctx.moveTo(marginL, y); ctx.lineTo(marginL + w, y); ctx.stroke();
      ctx.fillStyle = '#8b93a1';
      ctx.fillText(t.toFixed(dec), marginL - 5, y);
    });

    // barras
    const n = values.length;
    const slot = w / n;
    const bw = Math.min(slot * 0.7, 46);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    values.forEach((v, i) => {
      const cx = marginL + slot * (i + 0.5);
      if (typeof v === 'number' && !Number.isNaN(v)) {
        const bh = (v / yMax) * h;
        ctx.fillStyle = i === n - 1 ? '#f6ad55' : (color || '#4fd1c5'); // hoy en otro color
        ctx.fillRect(cx - bw / 2, marginT + h - bh, bw, bh);
        if (slot > 26) {
          ctx.fillStyle = '#e6e8eb';
          ctx.font = '10px sans-serif';
          ctx.fillText(v.toFixed(v < 10 ? 1 : 0), cx, marginT + h - bh - 12);
        }
      }
      // etiqueta de día (DD/MM), una de cada N si hay poco espacio
      if (labels[i] && (n <= 16 || i % Math.ceil(n / 12) === 0 || i === n - 1)) {
        ctx.fillStyle = '#8b93a1';
        ctx.font = '9px sans-serif';
        ctx.fillText(labels[i], cx, marginT + h + 6);
      }
    });
  }

  // ---------- gráficas "en vivo" (buffer corto en memoria) ----------
  function liveSeriesOf(key) {
    return liveHistory.map((r) => (r.fields ? r.fields[key] : undefined));
  }

  function drawLiveCharts() {
    drawLineChart($('live-chart-v'),
      [liveSeriesOf('voltaje1'), liveSeriesOf('voltaje2'), liveSeriesOf('voltaje3')],
      ['#4fd1c5', '#f6ad55', '#63b3ed']);

    drawLineChart($('live-chart-i'),
      [liveSeriesOf('corriente1'), liveSeriesOf('corriente2'), liveSeriesOf('corriente3')],
      ['#4fd1c5', '#f6ad55', '#63b3ed']);

    drawLineChart($('live-chart-power'), [
      liveSeriesOf('potenciaTotal').map((v) => (v != null ? v / 1000 : v)),
      liveSeriesOf('potenciaReacTotal').map((v) => (v != null ? v / 1000 : v)),
      liveSeriesOf('potenciaApTotal').map((v) => (v != null ? v / 1000 : v)),
    ], ['#4fd1c5', '#f6ad55', '#63b3ed']);

    drawLineChart($('live-chart-f'),
      [liveSeriesOf('frecuencia')],
      ['#4fd1c5'], FREQ_RANGE);

    drawLineChart($('live-chart-fp'),
      [liveSeriesOf('factorPotencia').map((v) => (v != null ? Math.abs(v) : v))],
      ['#f6ad55'], PF_RANGE);
  }

  // ---------- histórico persistente (SQLite vía /api/history) ----------
  let horasActuales = 24;

  function histSeriesOf(rows, key) {
    return rows.map((r) => (r.fields ? r.fields[key] : undefined));
  }

  async function cargarHistorico(horas) {
    horasActuales = horas;
    try {
      const res = await fetch(`/api/history?horas=${horas}&maxPuntos=500`, { cache: 'no-store' });
      const rows = await res.json();

      drawLineChart($('hist-chart-v'),
        [histSeriesOf(rows, 'voltaje1'), histSeriesOf(rows, 'voltaje2'), histSeriesOf(rows, 'voltaje3')],
        ['#4fd1c5', '#f6ad55', '#63b3ed']);

      drawLineChart($('hist-chart-i'),
        [histSeriesOf(rows, 'corriente1'), histSeriesOf(rows, 'corriente2'), histSeriesOf(rows, 'corriente3')],
        ['#4fd1c5', '#f6ad55', '#63b3ed']);

      drawLineChart($('hist-chart-power'), [
        histSeriesOf(rows, 'potenciaTotal').map((v) => (v != null ? v / 1000 : v)),
        histSeriesOf(rows, 'potenciaReacTotal').map((v) => (v != null ? v / 1000 : v)),
        histSeriesOf(rows, 'potenciaApTotal').map((v) => (v != null ? v / 1000 : v)),
      ], ['#4fd1c5', '#f6ad55', '#63b3ed']);

      drawLineChart($('hist-chart-f'),
        [histSeriesOf(rows, 'frecuencia')],
        ['#4fd1c5'], FREQ_RANGE);

      drawLineChart($('hist-chart-fp'),
        [histSeriesOf(rows, 'factorPotencia').map((v) => (v != null ? Math.abs(v) : v))],
        ['#f6ad55'], PF_RANGE);
    } catch (e) {
      console.error('[historico] error cargando:', e);
    }
  }

  const rangeSelector = $('rangeSelector');
  rangeSelector.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-horas]');
    if (!btn) return;
    rangeSelector.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    cargarHistorico(parseFloat(btn.dataset.horas));
  });

  // ---------- consumo por día (SQLite vía /api/consumo-diario) ----------
  let diasConsumo = 14;

  async function cargarConsumoDiario(dias) {
    diasConsumo = dias;
    try {
      const res = await fetch(`/api/consumo-diario?dias=${dias}`, { cache: 'no-store' });
      const rows = await res.json();
      if (!Array.isArray(rows)) return;

      const labels = rows.map((r) => {
        const [y, m, d] = r.dia.split('-');
        return `${d}/${m}`;
      });
      const values = rows.map((r) => r.consumoKwh);
      drawBarChart($('consumo-diario-chart'), labels, values, '#4fd1c5');

      // "consumo hoy" en vivo: guarda el contador al inicio del día actual
      const hoy = rows[rows.length - 1];
      if (hoy && typeof hoy.kwhInicioDia === 'number') kwhInicioHoy = hoy.kwhInicioDia;

      // resumen: promedio de los días COMPLETOS (todos menos el último)
      const completos = values.slice(0, -1).filter((v) => typeof v === 'number');
      const prom = completos.length
        ? completos.reduce((a, b) => a + b, 0) / completos.length
        : null;
      $('consumo-resumen').textContent =
        (hoy ? `hoy ${grouped(hoy.consumoKwh, 2)} kWh` : '') +
        (prom != null ? `  ·  prom. ${grouped(prom, 2)} kWh/día` : '');
    } catch (e) {
      console.error('[consumo] error cargando:', e);
    }
  }

  const consumoRangeSelector = $('consumoRangeSelector');
  consumoRangeSelector.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-dias]');
    if (!btn) return;
    consumoRangeSelector.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    cargarConsumoDiario(parseInt(btn.dataset.dias, 10));
  });

  // refresca el histórico cada 2 minutos (sin interrumpir al usuario si está
  // viendo un rango específico)
  setInterval(() => cargarHistorico(horasActuales), 120000);
  setInterval(() => cargarConsumoDiario(diasConsumo), 120000);

  window.addEventListener('resize', () => {
    clearTimeout(window.__resizeT);
    window.__resizeT = setTimeout(() => {
      drawLiveCharts();
      cargarHistorico(horasActuales);
      cargarConsumoDiario(diasConsumo);
    }, 200);
  });

  // ---------- WebSocket con reconexión + fallback a polling ----------
  let ws = null;
  let wsConnectedOnce = false;
  let pollTimer = null;

  function startPollingFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/latest', { cache: 'no-store' });
        if (res.status !== 204) {
          const reading = await res.json();
          if (!liveHistory.length || reading.receivedAt !== liveHistory[liveHistory.length - 1].receivedAt) {
            liveHistory.push(reading);
            if (liveHistory.length > 120) liveHistory.shift();
            renderReading(reading);
          }
        }
      } catch (e) { /* silencioso, se reintenta en el próximo ciclo */ }
      try {
        const resDiag = await fetch('/api/diag', { cache: 'no-store' });
        if (resDiag.status !== 204) {
          const diag = await resDiag.json();
          if (diag.receivedAt !== lastDiagReceivedAt) renderDiag(diag);
        }
      } catch (e) { /* silencioso, se reintenta en el próximo ciclo */ }
    }, 5000);
  }
  function stopPollingFallback() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');

    ws.onopen = () => { wsConnectedOnce = true; stopPollingFallback(); };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.type === 'init') {
        liveHistory = (msg.payload.liveBuffer || []).slice();
        if (msg.payload.latest) renderReading(msg.payload.latest);
        if (msg.payload.latestDiag) renderDiag(msg.payload.latestDiag);
      } else if (msg.type === 'reading') {
        liveHistory.push(msg.payload);
        if (liveHistory.length > 120) liveHistory.shift();
        renderReading(msg.payload);
      } else if (msg.type === 'diag') {
        renderDiag(msg.payload);
      }
    };

    ws.onclose = () => { startPollingFallback(); setTimeout(connectWS, 3000); };
    ws.onerror = () => { ws.close(); };
  }

  setTimeout(() => { if (!wsConnectedOnce) startPollingFallback(); }, 4000);

  // carga inicial
  fetch('/api/live', { cache: 'no-store' })
    .then((r) => r.json())
    .then((buf) => {
      if (Array.isArray(buf) && buf.length) {
        liveHistory = buf;
        renderReading(buf[buf.length - 1]);
      }
    })
    .catch(() => {});

  fetch('/api/diag', { cache: 'no-store' })
    .then((r) => (r.status === 204 ? null : r.json()))
    .then((diag) => { if (diag) renderDiag(diag); })
    .catch(() => {});

  cargarHistorico(horasActuales);
  cargarConsumoDiario(diasConsumo);
  connectWS();
  updateStatusLoop();
  updateDiagStatusLoop();
})();

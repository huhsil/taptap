// 진행자(노트북) 화면: 방 생성 → QR 표시 → 폰 접속 수신 → 경주 진행
(() => {
  const $ = (s) => document.querySelector(s);
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const MAX_RATE = 12; // 1인당 초당 최대 인정 탭 수 (매크로/연타 방지)

  let teamCount = 4;
  let goal = 150;
  let teams = []; // {idx,name,color,taps,size}
  const players = new Map(); // pid -> {pid,name,team,taps,conn,online,lastT,allow}
  let phase = 'setup'; // setup | lobby | countdown | race | done
  let peer = null;
  let code = '';
  let raceTeams = [];
  let shown = [];
  let lastFrame = 0;
  let tickTimer = null;
  let tickCount = 0;
  let lastResult = null;

  /* ---------------- 말 SVG ---------------- */
  function horseSVG(color) {
    return `<svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg">
      <g class="leg b2"><rect x="35" y="52" width="7" height="30" rx="3" fill="#6b3d1a"/><rect x="34" y="78" width="9" height="6" rx="2" fill="#2a1a0e"/></g>
      <g class="leg f2"><rect x="71" y="52" width="7" height="30" rx="3" fill="#6b3d1a"/><rect x="70" y="78" width="9" height="6" rx="2" fill="#2a1a0e"/></g>
      <g class="body-bob">
        <g class="tail"><path d="M26 34 C8 34 0 52 5 70 C12 58 16 50 28 46 Z" fill="#3b2314"/></g>
        <ellipse cx="55" cy="44" rx="36" ry="17" fill="#b06a30"/>
        <polygon points="76,36 88,12 102,18 96,48 76,52" fill="#b06a30"/>
        <ellipse cx="108" cy="24" rx="15" ry="7.5" transform="rotate(32 108 24)" fill="#b06a30"/>
        <ellipse cx="118" cy="31" rx="5" ry="4" fill="#7c4a21"/>
        <polygon points="95,13 98,1 104,14" fill="#8a4f22"/>
        <path d="M86 12 C78 16 74 30 72 40 L80 38 C82 28 86 20 94 14 Z" fill="#3b2314"/>
        <circle cx="110" cy="22" r="2.2" fill="#111"/>
        <rect x="42" y="30" width="26" height="14" rx="4" fill="${color}"/>
        <ellipse cx="55" cy="24" rx="8" ry="11" fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <circle cx="58" cy="9" r="6" fill="#fcd5b0"/>
        <path d="M51 9 A7 7 0 0 1 65 9 Z" fill="${color}" stroke="#fff" stroke-width="1"/>
      </g>
      <g class="leg b1"><rect x="29" y="52" width="7" height="30" rx="3" fill="#8a4f22"/><rect x="28" y="78" width="9" height="6" rx="2" fill="#2a1a0e"/></g>
      <g class="leg f1"><rect x="77" y="52" width="7" height="30" rx="3" fill="#8a4f22"/><rect x="76" y="78" width="9" height="6" rx="2" fill="#2a1a0e"/></g>
    </svg>`;
  }

  /* ---------------- 설정 화면 ---------------- */
  function renderTeamNames() {
    const box = $('#team-names');
    const old = [...box.querySelectorAll('input')].map((i) => i.value);
    box.innerHTML = '';
    for (let i = 0; i < teamCount; i++) {
      const d = TD.TEAM_DEFS[i];
      const inp = document.createElement('input');
      inp.value = old[i] || d.name;
      inp.maxLength = 8;
      inp.style.borderColor = d.color;
      box.appendChild(inp);
    }
  }
  function seg(id, cb) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      cb(Number(b.dataset.v));
    });
  }
  seg('#seg-teams', (v) => { teamCount = v; renderTeamNames(); });
  seg('#seg-goal', (v) => { goal = v; });
  renderTeamNames();

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  $('#fs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  /* ---------------- 네트워크 ---------------- */
  function newCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return c;
  }
  function openPeer() {
    code = newCode();
    peer = new Peer(TD.PREFIX + code, TD.peerOptions());
    peer.on('open', () => {
      $('#status').textContent = '준비 완료 · 코드 ' + code;
      $('#btn-open').disabled = false;
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        try { peer.destroy(); } catch (e) {}
        openPeer();
        return;
      }
      $('#status').textContent = '연결 오류: ' + err.type;
      console.warn(err);
    });
    peer.on('disconnected', () => {
      $('#status').textContent = '서버와 끊김 · 재연결 중…';
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('connection', (conn) => {
      conn.on('data', (m) => onMsg(conn, m));
      conn.on('close', () => onClose(conn));
      conn.on('error', () => onClose(conn));
    });
  }

  function send(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) {}
  }
  function broadcast(msg) {
    players.forEach((p) => { if (p.online) send(p.conn, msg); });
  }
  function teamInfo() {
    return teams.map((t) => ({
      name: t.name,
      color: t.color,
      count: [...players.values()].filter((p) => p.online && p.team === t.idx).length,
    }));
  }
  let infoTimer = null;
  function scheduleInfo() {
    renderLobby();
    if (infoTimer) return;
    infoTimer = setTimeout(() => {
      infoTimer = null;
      if (phase === 'lobby') broadcast({ t: 'teams', teams: teamInfo() });
    }, 400);
  }

  function cleanName(s) {
    return String(s || '').replace(/[<>]/g, '').trim().slice(0, 8);
  }

  function onMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      send(conn, { t: 'teams', teams: teamInfo(), phase });
    } else if (m.t === 'join') {
      if (phase === 'setup') { send(conn, { t: 'reject', reason: '아직 게임이 준비되지 않았어요.' }); return; }
      let p = players.get(m.pid);
      const ti = Number(m.team);
      if (!p) {
        if (phase !== 'lobby') { send(conn, { t: 'reject', reason: '이미 경기가 시작되었어요. 다음 판을 기다려 주세요!' }); return; }
        if (!teams[ti]) { send(conn, { t: 'reject', reason: '팀을 다시 선택해 주세요.' }); return; }
        p = { pid: m.pid, name: '', team: ti, taps: 0, lastT: 0, allow: 0 };
        players.set(m.pid, p);
      }
      p.conn = conn;
      p.online = true;
      conn._pid = m.pid;
      p.name = cleanName(m.name) || p.name || '참가자' + (players.size);
      if (phase === 'lobby' && teams[ti]) p.team = ti;
      send(conn, { t: 'joined', team: p.team, name: p.name, phase, teams: teamInfo(), goal });
      if (phase === 'race') send(conn, { t: 'go' });
      if (phase === 'done' && lastResult) send(conn, lastResult);
      scheduleInfo();
    } else if (m.t === 'taps') {
      if (phase !== 'race') return;
      const p = players.get(conn._pid);
      if (!p) return;
      const now = performance.now();
      const dt = Math.min((now - p.lastT) / 1000, 2);
      p.lastT = now;
      p.allow = Math.min(p.allow + dt * MAX_RATE, MAX_RATE * 1.5);
      const n = Math.min(Math.max(0, Math.floor(Number(m.n) || 0)), Math.floor(p.allow));
      p.allow -= n;
      p.taps += n;
      teams[p.team].taps += n;
    }
  }
  function onClose(conn) {
    const p = players.get(conn._pid);
    if (p && p.conn === conn) {
      p.online = false;
      scheduleInfo();
    }
  }

  /* ---------------- 로비 ---------------- */
  function joinUrl() {
    const base = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
    let u = base + 'play.html?room=' + code;
    const pp = TD.params.get('peer');
    if (pp) u += '&peer=' + encodeURIComponent(pp);
    return u;
  }
  function renderQR() {
    const url = joinUrl();
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('#code').textContent = code;
    $('#url').textContent = url;
    const w = $('#warn');
    const local = location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (local && !TD.params.get('peer')) {
      w.textContent = '⚠ 지금 주소는 이 컴퓨터에서만 열려요. 폰에서 접속하려면 GitHub Pages 주소로 이 화면을 열어주세요.';
      w.classList.remove('hidden');
    }
  }
  function renderLobby() {
    const info = teamInfo();
    const total = info.reduce((a, b) => a + b.count, 0);
    $('#total').textContent = total;
    $('#btn-start').disabled = total < 1;
    const box = $('#team-cards');
    box.innerHTML = info
      .map((t, i) => {
        const names = [...players.values()].filter((p) => p.online && p.team === i).map((p) => `<span class="chip">${TD.esc(p.name)}</span>`).join('');
        return `<div class="team-card" style="--c:${t.color}"><div class="nm">${TD.esc(t.name)}</div><div class="cnt">${t.count}<small> 명</small></div><div class="chips">${names}</div></div>`;
      })
      .join('');
  }

  $('#btn-open').onclick = () => {
    const names = [...$('#team-names').querySelectorAll('input')].map((i) => i.value.trim());
    teams = [];
    for (let i = 0; i < teamCount; i++) {
      teams.push({ idx: i, name: names[i] || TD.TEAM_DEFS[i].name, color: TD.TEAM_DEFS[i].color, taps: 0, size: 0 });
    }
    phase = 'lobby';
    renderQR();
    renderLobby();
    show('#s-lobby');
  };

  /* ---------------- 경주 ---------------- */
  function buildLanes() {
    const box = $('#lanes');
    box.innerHTML = '';
    raceTeams.forEach((t) => {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.style.setProperty('--c', t.color);
      lane.innerHTML = `<div class="lane-label"><div class="n">${TD.esc(t.name)}</div><div class="s">${t.size}명</div></div>
        <div class="track"><div class="finish"></div><div class="pct">0%</div><div class="horse idle">${horseSVG(t.color)}</div></div>`;
      box.appendChild(lane);
      t.el = lane;
      t.horse = lane.querySelector('.horse');
      t.pctEl = lane.querySelector('.pct');
      t.track = lane.querySelector('.track');
    });
    shown = raceTeams.map(() => 0);
  }
  function prog(t) {
    return Math.min(1, t.taps / Math.max(1, t.size) / goal);
  }

  function startCountdown() {
    players.forEach((p) => { p.taps = 0; });
    teams.forEach((t) => {
      t.taps = 0;
      t.size = [...players.values()].filter((p) => p.online && p.team === t.idx).length;
    });
    raceTeams = teams.filter((t) => t.size > 0);
    phase = 'countdown';
    $('#result').classList.add('hidden');
    show('#s-race');
    buildLanes();
    lastFrame = performance.now();
    requestAnimationFrame(frame);

    const cd = $('#cd');
    let n = 3;
    const step = () => {
      cd.classList.remove('hidden');
      cd.classList.remove('pop');
      void cd.offsetWidth;
      cd.classList.add('pop');
      if (n > 0) {
        cd.firstChild.textContent = n;
        broadcast({ t: 'cd', n });
        TD.beep(440, 0.2);
        n--;
        setTimeout(step, 1000);
      } else {
        cd.firstChild.textContent = 'GO!';
        TD.beep(880, 0.5, 0.12);
        goRace();
        setTimeout(() => cd.classList.add('hidden'), 800);
      }
    };
    step();
  }
  function goRace() {
    phase = 'race';
    const now = performance.now();
    players.forEach((p) => { p.lastT = now; p.allow = 4; });
    broadcast({ t: 'go' });
    raceTeams.forEach((t) => t.horse.classList.remove('idle'));
    tickCount = 0;
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 100);
  }
  function tick() {
    if (phase !== 'race') return;
    tickCount++;
    const ps = raceTeams.map((t) => prog(t));
    if (tickCount % 2 === 0) {
      const arr = teams.map((t) => (raceTeams.includes(t) ? prog(t) : 0));
      broadcast({ t: 'p', p: arr });
    }
    if (ps.some((p) => p >= 1)) finish();
  }
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    raceTeams.forEach((t, i) => {
      const target = prog(t);
      const prev = shown[i];
      shown[i] += (target - prev) * Math.min(1, dt * 7);
      const track = t.track.clientWidth;
      const hw = t.horse.clientWidth;
      const x = shown[i] * Math.max(0, track - hw - 34);
      t.horse.style.transform = `translateX(${x}px)`;
      t.pctEl.textContent = Math.round(shown[i] * 100) + '%';
      const speed = dt > 0 ? (shown[i] - prev) / dt : 0; // 초당 진행률
      const dur = Math.max(0.22, 0.75 - speed * 9);
      t.horse.style.setProperty('--gal', dur.toFixed(2) + 's');
      if (phase === 'race' || phase === 'countdown') t.horse.classList.toggle('idle', phase === 'countdown' || speed < 0.002);
    });
    if (phase === 'race' || phase === 'countdown' || phase === 'done') requestAnimationFrame(frame);
  }

  function finish() {
    phase = 'done';
    clearInterval(tickTimer);
    const ranking = raceTeams
      .map((t) => ({ team: t.idx, name: t.name, color: t.color, prog: prog(t) }))
      .sort((a, b) => b.prog - a.prog);
    const top = [...players.values()]
      .sort((a, b) => b.taps - a.taps)
      .slice(0, 3)
      .map((p) => ({ name: p.name, team: p.team, taps: p.taps }));
    lastResult = { t: 'end', ranking: ranking.map((r) => ({ team: r.team, prog: r.prog })), top };
    broadcast(lastResult);
    raceTeams.forEach((t) => t.horse.classList.add('idle'));
    TD.beep(660, 0.15); setTimeout(() => TD.beep(880, 0.15), 160); setTimeout(() => TD.beep(1100, 0.4), 330);

    const medal = ['🥇', '🥈', '🥉'];
    const win = ranking[0];
    const res = $('#result');
    res.innerHTML = `
      <h2 style="color:${win.color}">🏆 ${TD.esc(win.name)} 우승!</h2>
      <div class="rank">${ranking
        .map((r, i) => `<div class="rank-row" style="--c:${r.color}"><span class="no">${medal[i] || i + 1}</span><span class="grow">${TD.esc(r.name)}</span><small>${Math.round(r.prog * 100)}%</small></div>`)
        .join('')}</div>
      <div class="mvp">🔥 탭 MVP<br>${top.map((p, i) => `${i + 1}위 <b>${TD.esc(p.name)}</b> (${TD.esc(teams[p.team].name)}) ${p.taps}탭`).join('<br>')}</div>
      <div class="actions"><button class="btn" id="btn-again">같은 팀으로 다시!</button><button class="btn secondary" id="btn-new">처음으로</button></div>`;
    res.classList.remove('hidden');
    $('#btn-again').onclick = again;
    $('#btn-new').onclick = () => location.reload();
    confetti(win.color);
  }
  function again() {
    phase = 'lobby';
    lastResult = null;
    players.forEach((p) => { p.taps = 0; });
    teams.forEach((t) => { t.taps = 0; });
    $('#result').classList.add('hidden');
    show('#s-lobby');
    renderLobby();
    broadcast({ t: 'lobby', teams: teamInfo() });
  }
  function confetti(color) {
    const cols = [color, '#fbbf24', '#fff', '#f472b6', '#60a5fa'];
    for (let i = 0; i < 90; i++) {
      const d = document.createElement('div');
      d.className = 'confetti';
      d.style.left = Math.random() * 100 + 'vw';
      d.style.background = cols[i % cols.length];
      d.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      d.style.animationDelay = Math.random() * 1.2 + 's';
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 7000);
    }
  }

  $('#btn-start').onclick = () => {
    if (phase === 'lobby') startCountdown();
  };

  openPeer();
})();

// 참가자(스마트폰) 화면
(() => {
  const $ = (s) => document.querySelector(s);
  const room = (TD.params.get('room') || '').toUpperCase();

  let peer = null;
  let conn = null;
  let pid = sessionStorage.getItem('td-pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('td-pid', pid);
  }
  let roomCode = room;
  let teams = [];
  let myTeam = null; // 이미 가입했으면 팀 번호
  let myName = localStorage.getItem('td-name') || '';
  let phase = 'join';
  let myTaps = 0;
  let pending = 0;
  let sender = null;
  let retries = 0;
  let wantTeam = null;

  function show(id) {
    document.querySelectorAll('.pscreen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }
  function msg(title, text, retry) {
    $('#m-title').textContent = title;
    $('#m-text').textContent = text;
    $('#btn-retry').classList.toggle('hidden', !retry);
    show('#p-msg');
  }
  function teamColor() {
    return myTeam != null && teams[myTeam] ? teams[myTeam].color : '#334155';
  }
  function setTheme() {
    const c = teamColor();
    document.documentElement.style.setProperty('--c', c);
    document.body.style.setProperty('--c', c);
  }

  /* ---------- 입장 코드 ---------- */
  $('#btn-code').onclick = () => {
    const v = $('#in-code').value.trim().toUpperCase();
    if (v.length < 4) return;
    roomCode = v;
    start();
  };

  /* ---------- 연결 ---------- */
  function start() {
    show('#p-connecting');
    connect();
  }
  function connect() {
    try { if (conn) conn.close(); } catch (e) {}
    if (!peer || peer.destroyed) {
      peer = new Peer(undefined, TD.peerOptions());
      peer.on('open', doConnect);
      peer.on('error', onPeerError);
      peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    } else if (peer.open) {
      doConnect();
    }
  }
  function doConnect() {
    const c = (conn = peer.connect(TD.PREFIX + roomCode, { reliable: true }));
    // 10초 안에 연결이 안 되면 포기하고 재시도 (ICE 협상이 멈춘 경우 대비)
    setTimeout(() => {
      if (conn === c && !c.open) {
        try { c.close(); } catch (e) {}
        $('#conn-msg').textContent = '연결이 오래 걸려요… 다시 시도 중 (' + (retries + 1) + ')';
        onLost();
      }
    }, 10000);
    conn.on('open', () => {
      retries = 0;
      $('#banner').classList.add('hidden');
      if (myTeam != null) {
        // 재접속: 기존 팀으로 바로 복귀
        conn.send({ t: 'join', pid, name: myName, team: myTeam });
      } else {
        conn.send({ t: 'hello' });
      }
      startSender();
    });
    conn.on('data', onData);
    conn.on('close', onLost);
    conn.on('error', onLost);
  }
  function onPeerError(err) {
    if (err.type === 'peer-unavailable') onLost();
    else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') onLost();
    else console.warn(err);
  }
  function onLost() {
    if (phase === 'rejected') return;
    retries++;
    if (retries > 25) {
      msg('연결할 수 없어요', '진행자 화면이 열려 있는지, 접속 코드가 맞는지 확인해 주세요.', true);
      return;
    }
    if (myTeam != null || retries > 1) $('#banner').classList.remove('hidden');
    setTimeout(() => {
      if (conn && conn.open) return;
      if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) {} }
      if (peer && peer.open) doConnect();
      else connect();
    }, 1500);
  }
  $('#btn-retry').onclick = () => { retries = 0; start(); };

  function startSender() {
    clearInterval(sender);
    sender = setInterval(() => {
      if (pending > 0 && conn && conn.open) {
        try { conn.send({ t: 'taps', n: pending }); pending = 0; } catch (e) {}
      }
    }, 100);
  }

  /* ---------- 팀 선택 ---------- */
  function renderJoin() {
    $('#in-name').value = myName;
    $('#team-btns').innerHTML = teams
      .map((t, i) => `<button class="team-btn" style="--c:${t.color}" data-i="${i}"><span>${TD.esc(t.name)}</span><small>${t.count}명</small></button>`)
      .join('');
  }
  $('#team-btns').addEventListener('click', (e) => {
    const b = e.target.closest('.team-btn');
    if (!b || !conn || !conn.open) return;
    myName = $('#in-name').value.trim();
    localStorage.setItem('td-name', myName);
    wantTeam = Number(b.dataset.i);
    conn.send({ t: 'join', pid, name: myName, team: wantTeam });
  });
  $('#btn-change').onclick = () => {
    myTeam = null;
    setTheme();
    renderJoin();
    show('#p-join');
    if (conn && conn.open) conn.send({ t: 'hello' });
  };

  /* ---------- 수신 ---------- */
  function onData(m) {
    if (!m) return;
    switch (m.t) {
      case 'teams':
        teams = m.teams;
        if (myTeam == null) {
          phase = m.phase;
          if (m.phase !== 'lobby') { phase = 'rejected'; msg('경기 진행 중', '이미 경기가 시작되었어요. 다음 판을 기다려 주세요!'); return; }
          renderJoin();
          if (!$('#p-join').classList.contains('active')) show('#p-join');
        }
        break;
      case 'joined':
        myTeam = m.team;
        teams = m.teams;
        myName = m.name;
        setTheme();
        phase = m.phase;
        $('#my-pill').textContent = teams[myTeam].name;
        $('#my-pill').style.setProperty('--c', teams[myTeam].color);
        $('#my-name').textContent = myName;
        if (m.phase === 'lobby') show('#p-lobby');
        else if (m.phase === 'race') toRace();
        break;
      case 'lobby':
        teams = m.teams;
        phase = 'lobby';
        myTaps = 0;
        pending = 0;
        if (myTeam != null) show('#p-lobby');
        break;
      case 'cd':
        if (myTeam == null) return;
        phase = 'countdown';
        document.body.style.background = teamColor();
        $('#p-cd').style.background = teamColor();
        $('#cd-num').textContent = m.n;
        show('#p-cd');
        if (navigator.vibrate) navigator.vibrate(30);
        break;
      case 'go':
        if (myTeam == null) return;
        toRace();
        break;
      case 'p':
        updateProgress(m.p);
        break;
      case 'end':
        toDone(m);
        break;
      case 'reject':
        phase = 'rejected';
        msg('입장할 수 없어요', m.reason);
        break;
    }
  }

  /* ---------- 탭 화면 ---------- */
  function toRace() {
    if (phase !== 'race') myTaps = 0;
    phase = 'race';
    setTheme();
    $('#t-count').textContent = myTaps;
    $('#t-team').textContent = teams[myTeam].name;
    $('#t-rank').textContent = '출발!';
    $('#t-bar').style.width = '0';
    show('#p-race');
    wake();
  }
  function updateProgress(p) {
    if (phase !== 'race' || myTeam == null) return;
    $('#t-bar').style.width = Math.round(p[myTeam] * 100) + '%';
    const rank = 1 + p.filter((x, i) => i !== myTeam && x > p[myTeam]).length;
    $('#t-rank').textContent = rank + '등 · ' + Math.round(p[myTeam] * 100) + '%';
  }
  const pad = $('#pad');
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (phase !== 'race') return;
    myTaps++;
    pending++;
    $('#t-count').textContent = myTaps;
    if (navigator.vibrate) navigator.vibrate(8);
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = e.clientX + 'px';
    r.style.top = e.clientY + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 450);
  });
  ['touchstart', 'touchmove', 'contextmenu', 'gesturestart', 'dblclick'].forEach((ev) =>
    document.addEventListener(ev, (e) => { if (e.target.closest('#p-race')) e.preventDefault(); }, { passive: false })
  );

  /* ---------- 결과 ---------- */
  function toDone(m) {
    if (myTeam == null) return;
    phase = 'done';
    const rk = m.ranking;
    const myRank = rk.findIndex((r) => r.team === myTeam) + 1;
    const win = rk[0].team === myTeam;
    document.body.style.background = '';
    $('#d-title').textContent = win ? '🏆 우리 팀 우승!!' : myRank > 0 ? myRank + '등! 수고했어요' : '경기 종료';
    $('#d-rank').innerHTML = rk
      .map((r, i) => `<div class="rank-row" style="--c:${teams[r.team].color}"><span class="no">${i + 1}</span><span class="grow">${TD.esc(teams[r.team].name)}</span><small>${Math.round(r.prog * 100)}%</small></div>`)
      .join('');
    $('#d-me').textContent = '내가 두드린 횟수: ' + myTaps + '탭';
    if (navigator.vibrate) navigator.vibrate(win ? [100, 50, 100, 50, 300] : 200);
    show('#p-done');
  }

  /* ---------- 화면 꺼짐 방지 ---------- */
  async function wake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (phase === 'race') wake();
      if (conn && !conn.open) onLost();
    }
  });

  setTheme();
  if (roomCode) start();
})();

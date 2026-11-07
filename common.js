// 공통 설정: PeerJS 옵션, 팀 색상, 유틸
(function () {
  const params = new URLSearchParams(location.search);

  window.TD = {
    params,
    PREFIX: 'tapderby-',
    TEAM_DEFS: [
      { name: '빨강팀', color: '#ef4444' },
      { name: '파랑팀', color: '#3b82f6' },
      { name: '초록팀', color: '#22c55e' },
      { name: '노랑팀', color: '#f59e0b' },
    ],
    // ?peer=host:port 를 붙이면 직접 띄운 PeerJS 서버를 사용 (테스트/자체 서버용)
    peerOptions() {
      const o = { debug: 1 };
      const p = params.get('peer');
      if (p) {
        const [h, port] = p.split(':');
        o.host = h;
        o.port = Number(port);
        o.path = '/';
        o.secure = false;
      } else {
        o.config = {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
          ],
        };
      }
      return o;
    },
    esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    beep(freq, dur, vol) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!TD._ac) TD._ac = new AC();
        const ac = TD._ac;
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.frequency.value = freq;
        o.type = 'square';
        g.gain.value = vol || 0.08;
        o.connect(g);
        g.connect(ac.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
        o.stop(ac.currentTime + dur);
      } catch (e) {}
    },
  };
})();

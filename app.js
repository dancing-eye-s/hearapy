/* ═══════════════════════════════════════════════════════════
   Hearapy — 100Hz 멀미 방지 케어 (웹 구현)
   근거: Kato M. 외, 나고야대 (2025), EHPM Vol.30
   핵심 프로토콜: 100Hz 순음, 이동 직전 60초 연속 노출
   ═══════════════════════════════════════════════════════════ */

'use strict';

const FREQUENCY = 100;        // Hz — 근거 논문 고정값
const SESSION_SEC = 60;       // 이동 직전 1분 노출
const FADE_IN = 1.0;          // s
const FADE_OUT = 0.5;         // s
const AMPLITUDE = 0.5;        // 선형 게인 목표 (기기 볼륨으로 최종 음압 조절)
const RING_CIRC = 2 * Math.PI * 132; // ring r=132

const store = {
  get(k, d) { try { const v = localStorage.getItem('hearapy.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hearapy.' + k, JSON.stringify(v)); } catch {} },
};

const $ = (id) => document.getElementById(id);
const prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ───────────────────────────────────────────
   ToneGenerator — Web Audio 실시간 100Hz 합성
   진실의 원천은 AudioContext.currentTime (오디오 클록)
   ─────────────────────────────────────────── */
class ToneGenerator {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.startAt = 0;
    this.duration = 0;
    this.active = false;
  }

  createContext(Ctx) {
    try { return new Ctx({ latencyHint: 'interactive' }); }
    catch { return new Ctx(); }
  }

  async unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio 미지원');
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = this.createContext(Ctx);
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // iOS/Safari에서 첫 사용자 제스처 안에 실제 오디오 그래프를 한번 건드려 둔다.
    try {
      const silent = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      silent.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      silent.connect(gain).connect(this.ctx.destination);
      silent.start(0);
    } catch {}

    return this.ctx;
  }

  async start(durationSec) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio 미지원');
    if (this.active) await this.stop(false);
    // 사용자 제스처에서 미리 unlock된 컨텍스트가 있으면 재사용한다.
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = this.createContext(Ctx);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.ctx.state !== 'running') throw new Error('오디오가 아직 시작되지 않았습니다.');

    const now = this.ctx.currentTime;
    const start = now + 0.02; // 렌더 안정용 짧은 리드타임

    // 100.000 Hz 사인파. OscillatorNode는 샘플레이트와 무관하게 정확한 주파수 보장.
    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.setValueAtTime(FREQUENCY, start);

    // 모노 → 스테레오 destination 으로 좌우 동일 위상·동일 진폭 전달 (논문의 양측 동일 자극).
    this.gain = this.ctx.createGain();
    this.gain.gain.setValueAtTime(0.0001, start);
    // 페이드인 (지수 램프 — 클릭/팝 방지)
    this.gain.gain.exponentialRampToValueAtTime(AMPLITUDE, start + FADE_IN);
    // 페이드아웃 예약
    const fadeStart = start + durationSec - FADE_OUT;
    this.gain.gain.setValueAtTime(AMPLITUDE, fadeStart);
    this.gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

    this.osc.connect(this.gain).connect(this.ctx.destination);
    this.osc.start(start);
    this.osc.stop(start + durationSec + 0.05);

    this.startAt = start;
    this.duration = durationSec;
    this.active = true;
    return this.ctx;
  }

  /** 남은 초 (오디오 클록 기준). 세션 종료 판단의 진실의 원천. */
  remaining() {
    if (!this.ctx || !this.active) return 0;
    const elapsed = this.ctx.currentTime - this.startAt;
    return Math.max(0, this.duration - elapsed);
  }

  async stop(fade = true) {
    if (!this.ctx) { this.active = false; return; }
    const ctx = this.ctx;
    this.active = false;
    try {
      if (fade && this.gain && ctx.state === 'running') {
        const t = ctx.currentTime;
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(Math.max(this.gain.gain.value, 0.0001), t);
        this.gain.gain.exponentialRampToValueAtTime(0.0001, t + FADE_OUT);
        await new Promise((r) => setTimeout(r, FADE_OUT * 1000 + 20));
      }
      if (this.osc) { try { this.osc.stop(); } catch {} }
    } catch {}
    try { await ctx.close(); } catch {}
    this.ctx = null; this.osc = null; this.gain = null;
  }

  /** 시스템 볼륨은 웹에서 읽을 수 없음 → null. (F5 근사) */
  outputVolume() { return null; }
}

/* ───────────────────────────────────────────
   SessionController — 상태 머신
   idle → running → completed | aborted
   ─────────────────────────────────────────── */
class SessionController {
  constructor(tone, hooks) {
    this.tone = tone;
    this.hooks = hooks;
    this.state = 'idle';
    this.raf = 0;
    this.tickSec = SESSION_SEC;
  }

  async start() {
    if (this.state === 'running') return;
    this.state = 'running';
    this.tickSec = SESSION_SEC;
    try {
      await this.tone.start(SESSION_SEC);
    } catch (e) {
      this.state = 'idle';
      this.hooks.onError?.(e);
      return;
    }
    this.hooks.onStart?.();
    this._loop();
    // rAF가 스로틀/정지돼도 세션이 반드시 완료되도록 벽시계 안전장치.
    // 오디오는 오디오 클록으로 이미 정확히 스케줄됨(§F1). 이 타이머는 종료 트리거일 뿐.
    clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => this._finish(), SESSION_SEC * 1000 + 250);
  }

  _loop() {
    const step = () => {
      if (this.state !== 'running') return;
      const rem = this.tone.remaining();
      this.hooks.onTick?.(rem);
      const secLeft = Math.ceil(rem);
      if (secLeft !== this.tickSec) {
        this.tickSec = secLeft;
        this.hooks.onSecond?.(secLeft);
      }
      if (rem <= 0.01) return this._finish();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  async _finish() {
    if (this.state !== 'running') return;
    this.state = 'completed';
    cancelAnimationFrame(this.raf);
    clearTimeout(this.safetyTimer);
    await this.tone.stop(false); // 오디오가 이미 페이드아웃 완료
    this.hooks.onComplete?.();
  }

  async abort(reason) {
    if (this.state !== 'running') return;
    this.state = 'aborted';
    cancelAnimationFrame(this.raf);
    clearTimeout(this.safetyTimer);
    await this.tone.stop(true);
    this.hooks.onAbort?.(reason);
  }
}

/* ───────────────────────────────────────────
   HapticsController — Vibration API (지원 시)
   감성 요소. 효과 근거 아님. 설정에서 끌 수 있음.
   ─────────────────────────────────────────── */
const haptics = {
  enabled: () => store.get('haptics', true) && 'vibrate' in navigator,
  impact() { if (this.enabled()) navigator.vibrate(12); },
  success() { if (this.enabled()) navigator.vibrate([14, 40, 24]); },
  tick() { if (this.enabled()) navigator.vibrate(6); },
  stop() { if ('vibrate' in navigator) navigator.vibrate(0); },
};

/* ───────────────────────────────────────────
   화면 라우터
   ─────────────────────────────────────────── */
const SCREENS = ['onboarding', 'home', 'session', 'complete', 'settings'];
let currentScreen = null;
function showScreen(name) {
  SCREENS.forEach((s) => { $('screen-' + s).hidden = (s !== name); });
  currentScreen = name;
}

/* ───────────────────────────────────────────
   시트 & 오버레이
   ─────────────────────────────────────────── */
const SHEETS = ['device', 'volume', 'safety', 'research'];
function openSheet(name) {
  $('overlay').hidden = false;
  $('sheet-' + name).hidden = false;
}
function closeSheets() {
  $('overlay').hidden = true;
  SHEETS.forEach((s) => { $('sheet-' + s).hidden = true; });
}
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ───────────────────────────────────────────
   테마 적용
   ─────────────────────────────────────────── */
function applyTheme() {
  const theme = store.get('theme', 'system');
  document.body.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme', theme === 'system' ? '' : theme);
  $('set-theme').value = theme;
}

/* ───────────────────────────────────────────
   이어폰(출력 장치) 감지 — 웹 한계 내 근사
   웹은 AirPods를 신뢰성 있게 식별할 수 없음.
   기기 라벨이 조회되면 안내만 하고 강제하지 않음.
   ─────────────────────────────────────────── */
const deviceState = { connected: false, label: '' };
async function detectAudioOutput() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return setDeviceUI(store.get('deviceConfirmed', false));
    const devs = await navigator.mediaDevices.enumerateDevices();
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const bt = outs.find((d) => /airpod|bluetooth|buds|헤드|이어|head|ear/i.test(d.label));
    if (bt) return setDeviceUI(true, bt.label);
    // 라벨 접근 불가(권한) 시 사용자 자기보고에 의존
    setDeviceUI(store.get('deviceConfirmed', false));
  } catch {
    setDeviceUI(store.get('deviceConfirmed', false));
  }
}
function setDeviceUI(connected, label = '') {
  deviceState.connected = connected;
  deviceState.label = label;
  const chip = $('device-chip');
  chip.classList.toggle('connected', connected);
  $('chip-text').textContent = connected
    ? (label ? '연결됨 · ' + shortLabel(label) : '이어폰 사용 확인됨')
    : '이어폰을 연결하세요';
}
function shortLabel(l) { return l.length > 16 ? l.slice(0, 15) + '…' : l; }

/* ───────────────────────────────────────────
   세션 UI 바인딩
   ─────────────────────────────────────────── */
// 남은 시간에 따라 진행되는 코칭 문구 (첨부 레퍼런스 기준)
function coachFor(remSec) {
  if (remSec > 45) return '등을 기대고 깊게 숨을 들이쉬세요.';
  if (remSec > 30) return '100Hz 신호가 균형 중추를 조절하고 있습니다.';
  if (remSec > 15) return '몸이 움직임에 적응하고 있습니다. 거의 다 왔어요.';
  return '준비됐습니다. 여행을 즐기세요.';
}
function setCoach(text) {
  const c = $('coach');
  if (c.textContent === text) return;
  if (prefersReduce) { c.textContent = text; return; }
  c.style.opacity = '0';
  setTimeout(() => { c.textContent = text; c.style.opacity = '1'; }, 350);
}

function fmt(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const tone = new ToneGenerator();
let endBtnTimer = 0;
async function unlockAudioForGesture() {
  try { await tone.unlock(); return true; }
  catch { return false; }
}

const session = new SessionController(tone, {
  onStart() {
    document.body.classList.add('in-session');
    if (store.get('darkSession', false)) document.querySelector('.app').classList.add('session-dark');
    showScreen('session');
    haptics.impact();
    // 코칭 문구: 남은 시간에 따라 진행
    $('coach').textContent = coachFor(SESSION_SEC);
    $('coach').style.opacity = '1';
    acquireWakeLock();
    // 볼륨 배너(웹은 시스템 볼륨 미확인 → 조용한 안내만 1회)
    updateRing(SESSION_SEC);
    $('timer').textContent = fmt(SESSION_SEC);
  },
  onTick(rem) { updateRing(rem); },
  onSecond(secLeft) {
    $('timer').textContent = fmt(secLeft);
    setCoach(coachFor(secLeft));
    if (secLeft <= 5 && secLeft > 0) {
      const t = $('timer');
      t.classList.remove('pulse'); void t.offsetWidth; t.classList.add('pulse');
      haptics.tick();
    }
  },
  onComplete() { endSessionCleanup(); haptics.success(); showScreen('complete'); },
  onAbort(reason) {
    endSessionCleanup();
    haptics.stop();
    showScreen('home');
    setHomeStatus('대기 중');
    if (reason) toast(reason);
  },
  onError() {
    endSessionCleanup();
    showScreen('home');
    setHomeStatus('대기 중');
    toast('오디오를 시작할 수 없어요. 무음 모드와 볼륨을 확인한 뒤 다시 탭해 주세요.', 3600);
  },
});

function updateRing(rem) {
  const frac = 1 - rem / SESSION_SEC; // 0 → 1 로 소진
  $('ring-progress').style.strokeDashoffset = (RING_CIRC * frac).toFixed(2);
}

function endSessionCleanup() {
  document.body.classList.remove('in-session');
  document.querySelector('.app').classList.remove('session-dark');
  clearTimeout(endBtnTimer);
  $('end-session').hidden = true;
  $('volume-banner').hidden = true;
  releaseWakeLock();
}

function setHomeStatus(text) { $('home-status-text').textContent = text; }

/* ───────────────────────────────────────────
   Wake Lock — 세션 중 화면 유지
   ─────────────────────────────────────────── */
let wakeLock = null;
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() { try { wakeLock?.release?.(); } catch {} wakeLock = null; }

/* ───────────────────────────────────────────
   세션 시작 트리거
   ─────────────────────────────────────────── */
async function requestStart() {
  if (session.state === 'running') return;
  await unlockAudioForGesture();
  // 첫 세션 전 '100HZ 전정 안정화' 안내 화면을 1회 노출
  if (!store.get('tipsSeen', false)) { showTips(true); return; }
  setHomeStatus('시작하는 중…');
  await session.start();
}

// 세션 안내(100HZ 전정 안정화) 화면
function showTips(beforeSession) {
  $('screen-tips').dataset.beforeSession = beforeSession ? '1' : '';
  $('screen-tips').hidden = false;
}
function hideTips() { $('screen-tips').hidden = true; }

/* ───────────────────────────────────────────
   온보딩 캐러셀
   ─────────────────────────────────────────── */
function initOnboarding(firstRun) {
  const track = $('onboarding-track');
  const viewport = $('onb-viewport');
  const dots = [...$('onb-dots').children];
  const nextBtn = $('onb-next');
  const LAST = 2;
  let idx = 0;
  $('onboarding-close').hidden = firstRun; // 최초 실행엔 닫기 없음

  function render() {
    track.style.transition = 'transform 0.4s var(--ease)';
    track.style.transform = `translateX(${-idx * 100}%)`;
    dots.forEach((d, k) => d.classList.toggle('is-active', k === idx));
    nextBtn.textContent = idx === LAST ? (firstRun ? '동의하고 시작' : '완료') : '다음';
  }
  function go(i) { idx = Math.max(0, Math.min(LAST, i)); render(); }

  nextBtn.onclick = () => {
    if (idx < LAST) go(idx + 1);
    else if (firstRun) openSheet('safety');
    else finishOnboarding();
  };
  $('onboarding-close').onclick = finishOnboarding;

  // 터치/포인터 스와이프
  let startX = 0, dragging = false, w = 1;
  const down = (x) => { dragging = true; startX = x; w = viewport.clientWidth || 1; track.style.transition = 'none'; };
  const move = (x) => {
    if (!dragging) return;
    const dx = x - startX;
    track.style.transform = `translateX(calc(${-idx * 100}% + ${dx}px))`;
  };
  const up = (x) => {
    if (!dragging) return;
    dragging = false;
    const dx = x - startX;
    if (Math.abs(dx) > w * 0.18) go(dx < 0 ? idx + 1 : idx - 1);
    else render();
  };
  viewport.addEventListener('pointerdown', (e) => down(e.clientX));
  viewport.addEventListener('pointermove', (e) => move(e.clientX));
  viewport.addEventListener('pointerup', (e) => up(e.clientX));
  viewport.addEventListener('pointercancel', () => { if (dragging) { dragging = false; render(); } });
  viewport.addEventListener('touchstart', (e) => down(e.touches[0].clientX), { passive: true });
  viewport.addEventListener('touchmove', (e) => move(e.touches[0].clientX), { passive: true });
  viewport.addEventListener('touchend', (e) => up((e.changedTouches[0] || {}).clientX || startX));

  go(0);
}
function finishOnboarding() {
  store.set('onboarded', true);
  showScreen('home');
}

/* ───────────────────────────────────────────
   이벤트 바인딩
   ─────────────────────────────────────────── */
function bind() {
  // 홈
  $('play-btn').addEventListener('click', requestStart);
  $('play-btn').addEventListener('pointerdown', unlockAudioForGesture);
  $('device-chip').addEventListener('click', () => openSheet('device'));
  $('open-settings').addEventListener('click', () => showScreen('settings'));

  // 세션 — 화면 탭 시 종료 버튼 3초 노출 (오조작 방지)
  $('screen-session').addEventListener('click', (e) => {
    if (session.state !== 'running') return;
    if (e.target.id === 'end-session') return;
    const btn = $('end-session');
    btn.hidden = false;
    clearTimeout(endBtnTimer);
    endBtnTimer = setTimeout(() => { btn.hidden = true; }, 3000);
  });
  $('end-session').addEventListener('click', () => session.abort('세션을 종료했어요.'));

  // 완료
  $('again-btn').addEventListener('click', requestStart);
  $('done-btn').addEventListener('click', () => { showScreen('home'); setHomeStatus('대기 중'); });

  // 설정
  $('close-settings').addEventListener('click', () => showScreen('home'));
  $('set-haptics').checked = store.get('haptics', true);
  $('set-haptics').addEventListener('change', (e) => { store.set('haptics', e.target.checked); if (e.target.checked) haptics.impact(); });
  $('set-darksession').checked = store.get('darkSession', false);
  $('set-darksession').addEventListener('change', (e) => store.set('darkSession', e.target.checked));
  $('set-theme').addEventListener('change', (e) => { store.set('theme', e.target.value); applyTheme(); });
  $('show-tips').addEventListener('click', () => showTips(false));
  $('show-volume-guide').addEventListener('click', () => openSheet('volume'));
  $('show-onboarding').addEventListener('click', () => { showScreen('onboarding'); initOnboarding(false); });
  $('show-research').addEventListener('click', () => openSheet('research'));
  $('show-safety').addEventListener('click', () => openSheet('safety'));

  // 세션 안내(100HZ 전정 안정화) — '알겠습니다'
  $('tips-ok').addEventListener('click', async () => {
    await unlockAudioForGesture();
    const beforeSession = $('screen-tips').dataset.beforeSession === '1';
    store.set('tipsSeen', true);
    hideTips();
    if (beforeSession) { setHomeStatus('시작하는 중…'); await session.start(); }
  });

  // 시트 공통
  $('overlay').addEventListener('click', closeSheets);
  $('open-safety-onb').addEventListener('click', () => openSheet('safety'));

  // 이어폰 시트
  $('device-recheck').addEventListener('click', async () => {
    await detectAudioOutput();
    if (deviceState.connected) { store.set('deviceConfirmed', true); closeSheets(); toast('이어폰 사용을 확인했어요.'); }
    else { store.set('deviceConfirmed', true); setDeviceUI(true); closeSheets(); toast('이어폰 사용으로 표시했어요. 밀착형 이어폰을 권장합니다.'); }
  });
  $('device-force').addEventListener('click', async () => {
    await unlockAudioForGesture();
    closeSheets();
    toast('이어폰 확인 없이 재생합니다. 효과가 제한될 수 있어요.');
    setHomeStatus('시작하는 중…');
    session.start();
  });

  // 볼륨 시트
  $('volume-ok').addEventListener('click', () => { store.set('volumeGuided', true); closeSheets(); });

  // 안전 시트
  $('safety-agree').addEventListener('click', () => {
    store.set('safetyAgreed', true);
    closeSheets();
    if (!store.get('volumeGuided', false)) { finishOnboarding(); openSheet('volume'); }
    else finishOnboarding();
  });
  $('safety-close').addEventListener('click', closeSheets);
  $('research-close').addEventListener('click', closeSheets);

  // 인터럽트: 페이지 숨김/이탈 시 세션 중단 (연속 60초 프로토콜 보호)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session.state === 'running') {
      session.abort('세션이 중단됐어요. 다시 시작하세요.');
    }
  });
  // 출력 장치 변경 감지
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.('devicechange', () => {
      detectAudioOutput();
      if (session.state === 'running') session.abort('오디오 장치가 변경돼 중단됐어요.');
    });
  }
}

/* ───────────────────────────────────────────
   부트스트랩
   ─────────────────────────────────────────── */
function init() {
  applyTheme();
  bind();
  detectAudioOutput();

  if (!store.get('onboarded', false)) {
    showScreen('onboarding');
    initOnboarding(true);
  } else {
    showScreen('home');
  }
}
document.addEventListener('DOMContentLoaded', init);

// 디버그/검증 핸들 (콘솔에서 오디오 그래프 점검용)
window.Hearapy = { tone, session, store, FREQUENCY, SESSION_SEC };

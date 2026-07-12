/* =========================================================
   Grow My Earth — script.js
   -----------------------------------------------------------
   이 파일 하나로 게임의 모든 로직을 관리합니다.
   나중에 직접 수정할 부분은 아래 "CONFIG" 와 각 섹션의
   주석을 참고하세요. 섹션은 상단부터 순서대로 정리했습니다.
   ========================================================= */

/* ---------------------------------------------------------
   1. CONFIG — 여기만 바꿔도 게임 커스터마이징이 가능합니다
   --------------------------------------------------------- */
const CONFIG = {
  // Google Apps Script 웹앱 배포 URL을 여기에 붙여넣으세요.
  // 비워두면(빈 문자열) 이 브라우저(localStorage)에만 기록이 저장됩니다.
  // 설정 방법은 설명서.md 를 참고하세요.
  API_URL: "https://script.google.com/macros/s/AKfycbwA6_gZ_XBaEqAZ4izacRZpao4Awfnx4mH4kPd60QEc0yWKAV0e_o9UhxKaGIQTN419/exec", // 예: "https://script.google.com/macros/s/AKfycb.../exec"

  // 오늘의 행동 체크리스트
  ACTIONS: [
    { id: "transit", label: "대중교통 · 도보 · 자전거 이용하기", points: 10, co2: 0.5 },
    { id: "tumbler", label: "텀블러 · 다회용기 사용하기",        points: 8,  co2: 0.2 },
    { id: "food",    label: "잔반 없이 다 먹기",                 points: 6,  co2: 0.3 },
    { id: "power",   label: "안 쓰는 전등 · 전자기기 끄기",       points: 7,  co2: 0.1 },
    { id: "recycle", label: "분리배출 · 재활용 실천하기",         points: 8,  co2: 0.2 },
    { id: "reuse",   label: "일회용품 대신 다회용품 쓰기",         points: 9,  co2: 0.3 },
  ],

  MISSION_BONUS: 15,

  // 단계 임계값 (누적 포인트 기준)
  STAGES: [
    { min: 0,   name: "황폐한 행성" },
    { min: 50,  name: "바다 회복" },
    { min: 150, name: "초록 대륙" },
    { min: 300, name: "숲 무성" },
    { min: 500, name: "빛나는 생태계" },
  ],

  // 장식(꾸미기) 아이템 — unlock: 해금에 필요한 누적 포인트
  DECORATIONS: [
    { id: "tree",    icon: "🌳", name: "나무",       unlock: 50 },
    { id: "turbine", icon: "💨", name: "풍력발전기", unlock: 150 },
    { id: "panel",   icon: "☀️", name: "태양광 패널", unlock: 300 },
    { id: "animal",  icon: "🦋", name: "생물다양성", unlock: 500 },
  ],

  DECO_SLOT_COUNT: 6,

  BADGES: [
    { id: "first",    icon: "🌱", name: "첫 걸음",   test: s => s.totalCertifyDays >= 1 },
    { id: "streak3",  icon: "🔥", name: "3일 개근",  test: s => s.streak >= 3 },
    { id: "streak7",  icon: "🏅", name: "일주일 개근", test: s => s.streak >= 7 },
    { id: "points300",icon: "💎", name: "포인트 마스터", test: s => s.points >= 300 },
    { id: "co2_10",   icon: "🌍", name: "탄소 히어로", test: s => s.co2 >= 10 },
    { id: "gardener", icon: "🦋", name: "정원사",    test: s => s.decorations.length >= 3 },
  ],
};

/* ---------------------------------------------------------
   2. 상태(state) 관리 — localStorage 기반
   --------------------------------------------------------- */
const STORAGE_KEY = "gme_state_v1";
const NICK_KEY = "gme_nickname_v1";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function defaultState() {
  return {
    points: 0,
    streak: 0,
    lastCertifyDate: null, // "YYYY-MM-DD"
    co2: 0,
    totalCertifyDays: 0,
    decorations: [],        // [{slot: 0, decoId: "tree"}]
    unlockedBadges: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
  } catch { return defaultState(); }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let nickname = localStorage.getItem(NICK_KEY) || "";

/* ---------------------------------------------------------
   3. 오늘의 미션 / 이벤트 (날짜 기반 — 모두에게 동일)
   --------------------------------------------------------- */
function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

function getTodayMission() {
  const idx = dayOfYear() % CONFIG.ACTIONS.length;
  return CONFIG.ACTIONS[idx];
}

function isDoubleEventDay() {
  return new Date().getDate() % 7 === 0; // 7,14,21,28일 => 포인트 2배 이벤트
}

/* ---------------------------------------------------------
   4. 단계 / 진행도 계산
   --------------------------------------------------------- */
function getStageIndex(points) {
  let idx = 0;
  CONFIG.STAGES.forEach((s, i) => { if (points >= s.min) idx = i; });
  return idx;
}

function getStageProgress(points) {
  const idx = getStageIndex(points);
  const cur = CONFIG.STAGES[idx];
  const next = CONFIG.STAGES[idx + 1];
  if (!next) return { pct: 100, remain: 0, isMax: true };
  const pct = ((points - cur.min) / (next.min - cur.min)) * 100;
  return { pct, remain: next.min - points, isMax: false };
}

/* ---------------------------------------------------------
   5. 행성 SVG 렌더링 — 단계별로 모습이 달라집니다
   --------------------------------------------------------- */
function renderPlanet(points) {
  const stage = getStageIndex(points); // 0~4
  const svg = document.getElementById("planetSvg");

  const palettes = [
    { a: "#4a4038", b: "#221d17" }, // 0 황폐
    { a: "#2a7fb8", b: "#123b57" }, // 1 바다 회복
    { a: "#2f8f5e", b: "#155a3c" }, // 2 초록 대륙
    { a: "#3fae6b", b: "#0f6b3d" }, // 3 숲 무성
    { a: "#63d98b", b: "#12764a" }, // 4 빛나는 생태계
  ];
  const p = palettes[stage];
  const glow = stage >= 4 ? `<circle cx="200" cy="200" r="150" fill="url(#glowGrad)" class="pulse-glow"/>` : "";
  const clouds = stage >= 1 ? `
    <ellipse cx="150" cy="160" rx="38" ry="12" fill="rgba(255,255,255,0.25)"/>
    <ellipse cx="250" cy="230" rx="46" ry="14" fill="rgba(255,255,255,0.18)"/>` : "";
  const land = stage >= 2 ? `
    <path d="M150,140 Q190,110 230,140 Q250,170 220,200 Q180,220 150,190 Z" fill="rgba(60,150,90,0.55)"/>
    <path d="M230,230 Q270,220 280,250 Q270,280 240,270 Q220,250 230,230 Z" fill="rgba(60,150,90,0.45)"/>` : "";
  const forest = stage >= 3 ? `
    <path d="M120,230 Q150,210 170,240 Q160,265 130,260 Q110,250 120,230 Z" fill="rgba(20,110,60,0.6)"/>` : "";

  svg.innerHTML = `
    <defs>
      <radialGradient id="planetGrad" cx="35%" cy="30%" r="75%">
        <stop offset="0%" stop-color="${p.a}"/>
        <stop offset="100%" stop-color="${p.b}"/>
      </radialGradient>
      <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgba(99,217,139,0.35)"/>
        <stop offset="100%" stop-color="rgba(99,217,139,0)"/>
      </radialGradient>
    </defs>
    ${glow}
    <circle cx="200" cy="200" r="130" fill="none" stroke="#223049" stroke-width="1" stroke-dasharray="4 6"/>
    <circle cx="200" cy="200" r="110" fill="url(#planetGrad)"/>
    ${land}
    ${forest}
    ${clouds}
  `;

  document.getElementById("stageLabel").textContent =
    `단계 ${stage + 1} · ${CONFIG.STAGES[stage].name}`;
}

/* ---------------------------------------------------------
   6. 장식 슬롯 렌더링 (행성 궤도에 배치)
   --------------------------------------------------------- */
function renderDecoSlots() {
  const wrap = document.getElementById("decoSlots");
  wrap.innerHTML = "";
  const n = CONFIG.DECO_SLOT_COUNT;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const R = 46; // %
    const left = 50 + R * Math.cos(angle);
    const top = 50 + R * Math.sin(angle);
    const placed = state.decorations.find(d => d.slot === i);
    const deco = placed ? CONFIG.DECORATIONS.find(d => d.id === placed.decoId) : null;

    const el = document.createElement("div");
    el.className = "deco-slot" + (deco ? " filled" : "");
    el.style.left = `${left}%`;
    el.style.top = `${top}%`;
    el.textContent = deco ? deco.icon : "";
    el.title = deco ? deco.name : "빈 궤도 (클릭해서 장식 배치)";
    el.addEventListener("click", () => openDecoModal(i));
    wrap.appendChild(el);
  }
}

function openDecoModal(slotIndex) {
  const modal = document.getElementById("decoModal");
  const choices = document.getElementById("decoChoices");
  choices.innerHTML = "";

  CONFIG.DECORATIONS.forEach(deco => {
    const locked = state.points < deco.unlock;
    const btn = document.createElement("div");
    btn.className = "deco-choice" + (locked ? " locked" : "");
    btn.textContent = deco.icon;
    btn.title = locked ? `${deco.name} (${deco.unlock}P에 해금)` : deco.name;
    if (!locked) {
      btn.addEventListener("click", () => {
        state.decorations = state.decorations.filter(d => d.slot !== slotIndex);
        state.decorations.push({ slot: slotIndex, decoId: deco.id });
        saveState(state);
        renderDecoSlots();
        renderBadges();
        closeDecoModal();
      });
    }
    choices.appendChild(btn);
  });

  modal.classList.remove("hidden");
  modal._slot = slotIndex;
}
function closeDecoModal() {
  document.getElementById("decoModal").classList.add("hidden");
}

/* ---------------------------------------------------------
   7. 배지 렌더링
   --------------------------------------------------------- */
function renderBadges() {
  const shelf = document.getElementById("badgeShelf");
  shelf.innerHTML = "";
  CONFIG.BADGES.forEach(b => {
    const unlocked = b.test(state);
    const el = document.createElement("div");
    el.className = "badge" + (unlocked ? " unlocked" : "");
    el.innerHTML = `<div class="badge-icon">${b.icon}</div><div class="badge-name">${b.name}</div>`;
    shelf.appendChild(el);
  });
}

/* ---------------------------------------------------------
   8. 통계 / 진행도 UI 업데이트
   --------------------------------------------------------- */
function updateStatsUI() {
  document.getElementById("statPoints").textContent = state.points;
  document.getElementById("statStreak").innerHTML = `${state.streak}<small>일</small>`;
  document.getElementById("statCo2").innerHTML = `${state.co2.toFixed(1)}<small>kg</small>`;

  const prog = getStageProgress(state.points);
  document.getElementById("progressFill").style.width = `${Math.min(prog.pct, 100)}%`;
  document.getElementById("progressText").textContent = prog.isMax
    ? "최고 단계에 도달했습니다! 🎉"
    : `다음 단계까지 ${prog.remain}P`;
}

/* ---------------------------------------------------------
   9. 행동 체크리스트 렌더링
   --------------------------------------------------------- */
let checkedToday = new Set();

function renderActionList() {
  const list = document.getElementById("actionList");
  list.innerHTML = "";
  CONFIG.ACTIONS.forEach(action => {
    const li = document.createElement("li");
    li.className = "action-item";
    li.innerHTML = `
      <input type="checkbox" data-id="${action.id}">
      <span>${action.label}</span>
      <span class="action-co2">-${action.co2}kg CO₂</span>
    `;
    const checkbox = li.querySelector("input");
    li.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") checkbox.checked = !checkbox.checked;
      toggleAction(action.id, checkbox.checked, li);
    });
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => toggleAction(action.id, checkbox.checked, li));
    list.appendChild(li);
  });

  const mission = getTodayMission();
  document.getElementById("missionText").textContent = `"${mission.label}" 행동을 실천해보세요!`;
  document.getElementById("todayDate").textContent = todayStr();

  if (isDoubleEventDay()) {
    const banner = document.getElementById("eventBanner");
    banner.textContent = "🎉 오늘은 지구의 날! 모든 포인트가 2배로 적립됩니다.";
    banner.classList.remove("hidden");
  }

  // 오늘 이미 인증했다면 버튼 비활성화 + 체크 표시
  if (state.lastCertifyDate === todayStr()) {
    document.getElementById("certifyBtn").disabled = true;
    document.getElementById("certifyBtn").textContent = "오늘 인증 완료 ✅";
    document.getElementById("certifyMsg").textContent = "내일 다시 방문해서 지구를 더 키워주세요!";
  }
}

function toggleAction(id, checked, li) {
  if (checked) { checkedToday.add(id); li.classList.add("checked"); }
  else { checkedToday.delete(id); li.classList.remove("checked"); }
}

/* ---------------------------------------------------------
   10. 인증하기 (핵심 로직)
   --------------------------------------------------------- */
async function certifyToday() {
  if (state.lastCertifyDate === todayStr()) return;
  if (checkedToday.size === 0) {
    document.getElementById("certifyMsg").textContent = "체크한 행동이 없어요. 최소 1개 이상 선택해주세요!";
    return;
  }

  const mission = getTodayMission();
  const multiplier = isDoubleEventDay() ? 2 : 1;

  let earnedPoints = 0;
  let earnedCo2 = 0;
  CONFIG.ACTIONS.forEach(a => {
    if (checkedToday.has(a.id)) {
      earnedPoints += a.points;
      earnedCo2 += a.co2;
    }
  });
  if (checkedToday.has(mission.id)) earnedPoints += CONFIG.MISSION_BONUS;
  earnedPoints *= multiplier;

  // 연속기록(streak) 계산
  const yesterday = new Date(Date.now() - 86400000);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,"0")}-${String(yesterday.getDate()).padStart(2,"0")}`;
  if (state.lastCertifyDate === yStr) state.streak += 1;
  else state.streak = 1;

  state.points += earnedPoints;
  state.co2 += earnedCo2;
  state.totalCertifyDays += 1;
  state.lastCertifyDate = todayStr();
  saveState(state);

  document.getElementById("certifyMsg").textContent =
    `+${earnedPoints}P, -${earnedCo2.toFixed(1)}kg CO₂ 획득! 지구가 조금 더 건강해졌어요 🌍`;
  document.getElementById("certifyBtn").disabled = true;
  document.getElementById("certifyBtn").textContent = "오늘 인증 완료 ✅";

  renderPlanet(state.points);
  renderDecoSlots();
  renderBadges();
  updateStatsUI();

  // Google Sheets 연동이 설정되어 있으면 서버에도 기록
  if (CONFIG.API_URL) {
    try {
      await postCertify({
        nickname,
        pointsToAdd: earnedPoints,
        co2ToAdd: earnedCo2,
        dateStr: todayStr(),
      });
      loadLeaderboard();
    } catch (err) {
      console.error("서버 기록 실패 (로컬에는 저장됨):", err);
    }
  }
}

/* ---------------------------------------------------------
   11. Google Apps Script 연동 (선택 사항)
   --------------------------------------------------------- */
// Apps Script는 fetch 시 'text/plain'으로 보내면 CORS preflight를
// 피할 수 있어 별도 설정 없이도 동작합니다. (설명서.md 참고)
async function postCertify(payload) {
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "certify", ...payload }),
  });
  return res.json();
}

async function fetchLeaderboardFromServer() {
  const res = await fetch(`${CONFIG.API_URL}?type=leaderboard`);
  return res.json();
}

async function loadLeaderboard() {
  const listEl = document.getElementById("leaderboardList");

  if (!CONFIG.API_URL) {
    listEl.innerHTML = `<li class="lb-empty">Google Sheets 연동 시 전체 리더보드가 표시됩니다.<br>지금은 내 기록만 보여드려요.</li>`;
    const li = document.createElement("li");
    li.className = "lb-row me";
    li.innerHTML = `<span class="lb-rank">-</span><span class="lb-name">${nickname} (나)</span><span class="lb-points">${state.points}P</span>`;
    listEl.appendChild(li);
    document.getElementById("statRank").textContent = "-";
    return;
  }

  listEl.innerHTML = `<li class="lb-empty">불러오는 중...</li>`;
  try {
    const data = await fetchLeaderboardFromServer();
    listEl.innerHTML = "";
    (data.list || []).forEach((row, i) => {
      const li = document.createElement("li");
      li.className = "lb-row" + (row.nickname === nickname ? " me" : "");
      li.innerHTML = `<span class="lb-rank">${i + 1}</span><span class="lb-name">${row.nickname}</span><span class="lb-points">${row.points}P</span>`;
      listEl.appendChild(li);
    });
    const myRank = (data.list || []).findIndex(r => r.nickname === nickname) + 1;
    document.getElementById("statRank").textContent = myRank > 0 ? `${myRank}위` : "-";
  } catch (err) {
    listEl.innerHTML = `<li class="lb-empty">리더보드를 불러오지 못했어요.</li>`;
  }
}

/* ---------------------------------------------------------
   12. 로그인 / 화면 전환
   --------------------------------------------------------- */
function startGame() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("mainScreen").classList.remove("hidden");
  document.getElementById("playerName").textContent = nickname;

  renderPlanet(state.points);
  renderDecoSlots();
  renderActionList();
  renderBadges();
  updateStatsUI();
  loadLeaderboard();
}

document.getElementById("startBtn").addEventListener("click", () => {
  const val = document.getElementById("nicknameInput").value.trim();
  if (val.length < 2 || val.length > 10) {
    document.getElementById("loginError").textContent = "닉네임은 2~10자로 입력해주세요.";
    return;
  }
  nickname = val;
  localStorage.setItem(NICK_KEY, nickname);
  startGame();
});

document.getElementById("nicknameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("startBtn").click();
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  if (confirm("닉네임을 변경하시겠습니까? (게임 진행상황은 이 기기에 계속 저장되어 있습니다)")) {
    document.getElementById("mainScreen").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
  }
});

document.getElementById("certifyBtn").addEventListener("click", certifyToday);
document.getElementById("refreshBoard").addEventListener("click", loadLeaderboard);
document.getElementById("decoModalClose").addEventListener("click", closeDecoModal);
document.getElementById("decoModal").addEventListener("click", (e) => {
  if (e.target.id === "decoModal") closeDecoModal();
});

/* ---------------------------------------------------------
   13. 초기 진입
   --------------------------------------------------------- */
if (nickname) {
  document.getElementById("nicknameInput").value = nickname;
  startGame();
}

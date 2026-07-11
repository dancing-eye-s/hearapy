# Hearapy (웹) — 100Hz 멀미 방지 케어

이동 전 **60초** 동안 **100Hz 순수 사인파**를 재생해 멀미를 사전에 완화하는 웰니스 웹앱.
[PRD_hearapy.md](../PRD_hearapy.md)의 스펙과 뉴모픽 UI/UX를 그대로 구현했습니다.

## 실행

```bash
node hearapy/server.js       # http://localhost:4188
```

또는 정적 파일이므로 아무 정적 서버로도 서빙 가능 (`index.html` 기준).
`manifest.webmanifest` + `apple-mobile-web-app-capable` 로 홈 화면에 추가하면 전체화면 앱처럼 동작합니다.

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 5개 화면(온보딩·홈·세션·완료·설정) + 시트/오버레이 마크업 |
| `styles.css` | Apple HIG 기반 iOS 디자인 시스템(시스템 컬러·Dynamic Type·인셋 그룹 리스트·머티리얼), 라이트/다크, Reduce Motion 대응 |
| `app.js` | `ToneGenerator`(오디오) · `SessionController`(상태 머신) · 화면 라우터 · 이벤트 |
| `server.js` | 개발용 정적 서버 |
| `manifest.webmanifest` | PWA 매니페스트 |

## 과학적 충실도 (근거: Kato M. 외, 나고야대 2025, EHPM Vol.30)

- **정확한 100Hz**: `OscillatorNode`(type=sine)로 실시간 합성 — 사전 녹음 파일 없음. FFT 실측으로 100Hz 피크 확인.
- **60초 연속 프로토콜**: 진실의 원천은 `AudioContext.currentTime`(오디오 클록). rAF는 UI 갱신용이며, 벽시계 `setTimeout` 안전장치로 rAF 스로틀 시에도 완료 보장.
- **양측 동일 자극**: 모노 오실레이터를 스테레오 destination으로 → 좌우 동일 위상·동일 진폭.
- **클릭 방지**: 1.0s 페이드인 / 0.5s 페이드아웃(지수 램프).
- **이동 전 적용**: 완료 화면에서 "이동 전 적용이 가장 효과적" 안내.
- **인터럽트**: 페이지 숨김·오디오 장치 변경 시 세션 중단(연속성 보호).

### 웹 플랫폼 한계 (정직성)

- **시스템 볼륨 접근 불가** → 절대 dB(80–85 dBZ) 보장 불가. 볼륨 가이드(50–65%, 대화 수준)로 근사.
- **AirPods 식별 제한** → `enumerateDevices` 라벨 휴리스틱 + 사용자 자기보고. 강제하지 않고 안내만.
- **무음 스위치 우회 불가**(iOS Safari), **햅틱**은 `navigator.vibrate` 지원 기기 한정.

원 연구는 스피커 기반이며, 본 앱의 이어폰 전달은 일상 적용을 위한 각색입니다. 의료기기·치료가 아닙니다.

## UI/UX — Apple HIG 준수

- **시스템 컬러**: systemBlue(#007AFF/#0A84FF), 시맨틱 label/secondaryLabel, systemGrouped/secondarySystemBackground 등 라이트·다크 자동 대응.
- **타이포그래피**: SF Pro 시스템 폰트 + Dynamic Type 스타일 스케일(Large Title 34 / Body 17 / Footnote 13 …)과 표준 트래킹.
- **컴포넌트**: 라지 타이틀 내비게이션, 인셋 그룹 리스트, UISwitch·UIPageControl, 필드 프로미넌트/플레인 버튼, 머티리얼(블러) 시트·내비바·토스트, 44pt 터치 타깃, 안전 영역(safe-area) 반영.
- **깊이**: 시스템 크롬(내비·리스트·라벨)은 HIG의 반투명 머티리얼·절제된 그림자로, **세션 다이얼과 세션 안내(100HZ 전정 안정화)는 첨부 레퍼런스의 뉴모픽(soft-UI) 다이얼**로 표현 — 융기 디스크 + 인셋 웰 + 얇은 블루 프로그레스 링. 라이트/다크 모두 지원.
- **세션 코칭**: 남은 시간에 따라 문구가 진행(호흡 → 균형 중추 조절 → 움직임 적응 → 준비 완료).

## 검증 완료

온보딩(스와이프/버튼)·안전동의·홈(라이트/다크)·세션(100Hz 실측·카운트다운 링)·완료·종료·설정·테마전환·이어폰 시트/폴백 — 브라우저 프리뷰에서 확인, 콘솔 에러 없음.

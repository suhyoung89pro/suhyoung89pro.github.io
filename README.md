# Personal Homepage

컴퓨터 비전, 머신 비전, 인공지능을 소개하는 개인 홈페이지입니다. 별도 설치나
빌드 과정 없이 `index.html`을 바로 배포합니다.

## 내용 바꾸기

- 이름과 소개 문구: `index.html`
- GitHub 링크: `index.html`의 `github.com/suhyoung89pro`
- 색상과 화면 스타일: `styles.css` 상단의 색상 변수
- 관심 분야 카드: `index.html`의 `Focus Areas` 영역

## GitHub Pages로 공개하기

1. GitHub에서 `사용자이름.github.io` 형식의 Public 저장소를 만듭니다.
2. 이 폴더의 파일을 저장소 `main` 브랜치에 올립니다.
3. 저장소의 **Settings → Pages**로 이동합니다.
4. **Build and deployment → Source**를 **GitHub Actions**로 선택합니다.
5. Actions의 배포가 끝나면 `https://사용자이름.github.io/`에서
   홈페이지를 확인할 수 있습니다.

이 저장소 형식을 사용하면 별도 경로 없이 개인 대표 홈페이지 주소를 사용할 수
있습니다.

## Content Radar 데이터 처리

`/content-radar/`는 권한이 확인된 OTT 순위 파일을 주간 스냅숏, 자체 월간 점수와
화면용 TOP 3로 변환할 수 있습니다. Netflix Tudum 이용약관은 로봇·스크레이퍼 등
자동수단과 데이터 추출 및 허가 없는 재배포를 제한하므로, 이 저장소는 Tudum을
자동 다운로드하지 않습니다.

- 허가된 파일 가져오기: `node scripts/ott/import-netflix.mjs --input <파일.tsv>`
- 생성·검증: `node scripts/ott/build.mjs && node scripts/ott/validate.mjs`
- 검수 대기 목록: `content-radar/data/ott/review/unmapped.json`
- 카테고리 확정: `content-radar/data/ott/config/category-map.json`의 항목을 검토한 뒤 `status`를 `reviewed`로 지정
- 작품·기수 확정: `content-radar/data/ott/config/program-aliases.json`
- 출연자와 SNS: `content-radar/data/ott/entities/`에서 관리하며, 확인되지 않은 계정은 공개하지 않음

월간 순위는 공식 시청수가 아니라 주 종료일이 속한 달을 기준으로 각 주 순위에
`11 - 순위` 점수를 부여한 자체 누적 지표입니다. 데이터 공급처와 별도 사용 허가가
확보되면 해당 공급처용 예약 수집 어댑터를 추가할 수 있습니다.

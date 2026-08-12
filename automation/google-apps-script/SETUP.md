# YOLO 산업 적용 사례 자동 조사

이 Apps Script는 Google Sheet를 승인 UI로 사용합니다. 자동 조사는 Crossref에서 후보를 찾아 `검토 대기` 탭에 추가하고, 지원하는 논문 웹페이지에서 결과 Figure 후보를 찾아 이미지 관련 열을 채웁니다. PDF만 제공되는 논문은 공개 PDF 작업 큐와 GitHub 후보 파일을 통해 별도 추출 작업에 연결됩니다. 공개 웹 앱의 기본 응답은 검증 조건을 모두 통과한 행만 JSON으로 반환합니다.

## 승인 조건

다음 조건을 모두 만족해야 홈페이지에 표시됩니다.

1. `게시 승인`, `출처 확인`, `성능 조건 확인` 체크
2. 논문 제목과 HTTPS 원문 URL 입력
3. 결과 이미지가 있으면 `이미지 권리 확인` 체크와 HTTPS 이미지 출처·라이선스 입력

자동으로 찾은 이미지는 `결과 이미지 URL`, `이미지 출처 URL`, `이미지 라이선스`에 후보로 입력되며 `이미지 권리 확인`은 항상 해제됩니다. 이미지를 직접 확인한 뒤 이 체크박스를 다시 켜야 홈페이지에 이미지가 표시됩니다. 이미지 후보가 검토 중이어도 논문 제목과 설명 카드는 계속 공개됩니다.

시트 메뉴의 **YOLO 사례 조사 → 빈 결과 이미지 후보 찾기**를 실행하면 기존 행 중 이미지가 비어 있는 최대 10건을 조사합니다. 현재 자동 Figure 추출은 MDPI 정적 원문과 Research Square가 별도 Figure 파일을 제공하는 논문을 지원합니다. 논문 웹페이지에 PDF만 제공되는 engRxiv 및 일부 Research Square 논문은 `웹 Figure 없음 · PDF 추출 필요`로 메모되며, 잘못된 이미지를 추정해서 채우지 않습니다.

Figure 선택은 실제 현장·데이터셋의 검출 박스가 보이는 결과 이미지를 우선합니다. 성능 막대그래프, PR 곡선, 혼동행렬, 데이터 통계, 모델 구조도만 있는 Figure는 자동 후보에서 제외합니다.

## PDF Figure 자동 추출 연결

배포된 웹 앱의 `/exec?mode=pdf-queue`는 이미지가 비어 있고 `이미지 권리 확인`이 해제된 engRxiv·Research Square 논문을 최대 50건까지 PDF 작업 큐로 반환합니다. MDPI 등 웹 Figure 조사 대상과 현재 PDF 작업기가 지원하지 않는 출판사는 큐에서 제외됩니다. 큐에는 공개 논문 정보인 `paperId`, `title`, `doi`, `paperUrl`만 포함되며 체크박스, 검토 메모, 인용 정보 등 시트 내부 검토 데이터는 포함되지 않습니다. 기본 `/exec` 승인 피드 형식은 변경되지 않습니다.

외부 PDF 작업기는 결과를 저장소의 `automation/pdf-figure-worker/output/candidates.json`에 다음 계약으로 저장합니다.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-13T00:00:00Z",
  "candidates": [
    {
      "paperId": "CR-...",
      "doi": "10.0000/example",
      "paperUrl": "https://doi.org/10.0000/example",
      "imageUrl": "https://raw.githubusercontent.com/suhyoung89pro/suhyoung89pro.github.io/main/assets/yolo-research/auto/example.webp",
      "sourceUrl": "https://publisher.example/paper.pdf",
      "license": "CC BY 4.0",
      "figureLabel": "Figure 6",
      "note": "검출 결과"
    }
  ]
}
```

시트 메뉴의 **YOLO 사례 조사 → PDF 결과 이미지 후보 동기화**를 누르면 이 고정 파일을 읽습니다. 동기화는 스키마, 공개 HTTPS 호스트, 이미지의 저장소·경로, `CC BY 4.0`, 사례 ID·DOI·논문 URL 일치를 확인합니다. `이미지 권리 확인`이 이미 체크됐거나 이미지 관련 열 중 하나라도 값이 있으면 절대 덮어쓰지 않습니다. 새 후보를 쓸 때는 `이미지 권리 확인`을 해제한 상태로 저장하므로 사람이 이미지를 확인한 뒤 직접 승인해야 합니다.

성능 지표·값·측정 조건은 확보된 경우 함께 표시됩니다. 비어 있더라도 위 승인 체크를 완료하면 서지 정보 중심으로 게시됩니다. 새로 수집된 후보의 체크박스는 항상 해제되어 있습니다. 서로 다른 데이터셋이나 하드웨어에서 측정된 수치를 직접 순위화하지 마세요.

## 설치와 배포

1. 승인 시트에서 **확장 프로그램 → Apps Script**를 엽니다.
2. `Code.gs` 내용을 붙여 넣고 저장합니다.
3. `installWeeklyTrigger`를 한 번 실행해 권한을 승인합니다. 이때 연결된 시트 ID가 Apps Script의 비공개 속성에 저장됩니다.
4. **YOLO 사례 조사 → PDF 후보 일일 동기화 설치**를 한 번 실행합니다. 동일 함수의 기존 트리거만 교체하며, 매일 오전 9시에 후보를 안전하게 동기화합니다. 전체 자동 흐름은 Asia/Seoul 기준 GitHub Actions가 매일 오전 5시 17분에 PDF 큐를 처리하고 Apps Script가 오전 9시에 결과를 시트로 가져오는 순서입니다.
5. **배포 → 새 배포 → 웹 앱**에서 실행 사용자는 본인, 액세스 사용자는 모든 사용자로 배포합니다.
6. 생성된 `/exec` URL을 저장소의 `yolo-research-config.json`에 입력합니다. PDF 작업기는 같은 URL에 `?mode=pdf-queue`를 붙여 읽습니다.

웹 앱에는 쓰기 엔드포인트가 없습니다. PDF 큐 역시 제한된 공개 논문 메타데이터만 제공하며, 시트 편집 권한과 Apps Script 실행 권한은 공개 페이지에 노출하지 않습니다.

Crossref는 서지 메타데이터와 인용 수 후보를 제공할 뿐, 논문 성능 값이나 결과 이미지 재게시 권리를 보증하지 않습니다. 자동 이미지 조사는 논문별 CC BY 4.0 표시와 Figure 캡션을 확인하지만, 제3자 그림 여부를 완전히 보증하지 못하므로 사람이 최종 승인해야 합니다.

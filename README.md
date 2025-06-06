![ui_img_1](https://github.com/user-attachments/assets/92c6cf99-a642-49ab-ab98-7883f6bccd30)


# 웹응용기술[001]

# Node.JS를 통한 porfiler 구현

# 20230643 권순도

# 컴퓨터 공학과

☕ 실시간 커피 로스팅 데이터 분석 시스템(Roast Profiler) 개발 및 구현 ☕

# 1. 프로그램 개요
   이번에 만들게 된 커피 로스팅 데이터 분석 시스템은 커피 로스팅 과정에서 발생하는 다양한 온도 데이터를 실시간으로 수지브 분석 및 시각화하는 통합 시스템을 개발해보았습니다. Node.js 기반의 백엔드 시스템과 Chart.js 기반의 프론트엔드 대시보드를 결합하여 환경온도(ET), 원두온도(BT), 온도상승률(ROR)등의 핵심 로스팅 지표를 모니터링할 수 있도록 구축해보았습니다. 그리고 후에도 계속 연구할 수 있도록 MQTT 프로토콜을 통한 실시간 스트리밍 데이터 처리와 CSV 파일 기반의 배치 데이터 업로드를 지원하도록 하였으며, MySQL 데이터베이스를 활용한 데이터 영속성과 REST API를 통한 확장 가능한 인터페이스를 제공해보았습니다.

  # 2. 프로그래밍 수행 절차 분석
 로스팅 데이터 수집부터 통계 분석 및 시각화까지, 이 시스템은 다음과 같은 순서로 전체 기능을 수행합니다. 각 단계는 실제 구현된 파일과 함수 단위로 일치하며, 프론트엔드와 백엔드 간 상호작용이 REST API를 통해 이루어지고 있습니다.
## 시스템 개요
본 시스템은 데이터 수집, 처리, 저장, 분석을 통합적으로 수행하는 실시간 센서 데이터 모니터링 플랫폼입니다.

---

##  데이터 처리 흐름

### 1) 데이터 입력 관리

####  파일 업로드 처리
웹 인터페이스를 통한 CSV 파일 업로드 기능을 제공합니다.

```javascript
// index.html의 파일 업로드 이벤트 처리
uploadBtn.addEventListener('click', async () => {
  const file = datafile.files[0];
  const formData = new FormData();
  formData.append('datafile', file);
  await fetch('/upload', { method: 'POST', body: formData });
});
```

####  MQTT 실시간 데이터 수신
MQTT 프로토콜을 통해 실시간 센서 데이터를 수신하고 처리합니다.

```javascript
// mqtt-handler.js - 메시지 수신 및 처리
client.on('message', (topic, message) => {
  const data = JSON.parse(message.toString());
  if (typeof data === 'object') {
    ['ET', 'BT', 'ROR'].forEach(sensor => {
      if (data[sensor]) profiler.add(sensor, parseFloat(data[sensor]));
    });
  }
});
```

### 2) 데이터 파싱 및 검증

####  CSV 파일 형식 정규화
다양한 구분자를 지원하는 유연한 파싱 시스템을 구현했습니다.

```javascript
// server.js - CSV 파싱 설정
const parser = parse({
  delimiter: /[\t,]/, // 탭 또는 콤마 인식
  columns: header => header.map(h => h.trim().toUpperCase()),
});
```

####  센서 데이터 추출 및 변환
업로드된 데이터에서 센서 필드를 추출하고 수치형으로 변환합니다.

```javascript
// 센서 데이터 검증 및 추가
if (ET) profiler.add('ET', parseFloat(ET));
if (BT) profiler.add('BT', parseFloat(BT));
if (ROR) profiler.add('ROR', parseFloat(ROR));
```

### 3. 실시간 통계 처리

####  누적 통계 계산
Welford's 온라인 알고리즘을 사용하여 메모리 효율적인 실시간 통계를 계산합니다.

```javascript
// profiler.js - 실시간 통계 누적
add(value) {
  this.count++;
  const delta = value - this.mean;
  this.mean += delta / this.count;
  const delta2 = value - this.mean;
  this.m2 += delta * delta2;
}
```

####  통계 관리 인터페이스
센서별 독립적인 통계 관리 시스템을 제공합니다.

```javascript
// profiler-instance.js - 통계 관리
module.exports = {
  add(sensor, value) {
    if (!profilers[sensor]) profilers[sensor] = new RunningStats();
    profilers[sensor].add(value);
  },
  snapshot() {
    const result = {};
    for (const sensor in profilers) {
      result[sensor] = profilers[sensor].snapshot();
    }
    return result;
  }
};
```

### 4. 데이터베이스 저장

####  업로드 데이터 저장
파일 업로드를 통해 수집된 데이터를 MySQL 데이터베이스에 저장합니다.

```javascript
// server.js - 업로드 데이터 DB 저장
await connection.execute(
  `INSERT INTO raw_data (task_num, core_num, ET, BT, ROR) VALUES (?, ?, ?, ?, ?)`,
  [taskNum, coreNum, parseFloat(ET), parseFloat(BT), parseFloat(ROR)]
);
```

####  MQTT 데이터 저장
실시간으로 수신된 MQTT 데이터를 별도 테이블에 저장합니다.

```javascript
// mqtt-handler.js - MQTT 데이터 DB 저장
await connection.execute(
  `INSERT INTO mqtt_data (sensor, value) VALUES (?, ?)`,
  [sensor, value]
);
```

### 5. 데이터 출력 및 시각화

####  RESTful API 제공
통계 데이터를 JSON 형태로 제공하는 API 엔드포인트를 구현했습니다.

```javascript
// server.js - 통계 API
app.get('/stats', (req, res) => {
  res.json(profiler.snapshot());
});
```

####  프론트엔드 데이터 시각화
실시간 통계를 카드 형태와 차트로 시각화하여 사용자에게 표시합니다.

```javascript
// index.html - 데이터 시각화
const res = await fetch('/stats');
const stats = await res.json();
renderStatsCards(stats);
createCharts(stats);
```

---

##  시스템 아키텍처

```
 파일 업로드 ┐
            ├─→  파싱/검증 ─→  통계 처리 ─→ MySQL 저장
 MQTT 수신   ┘                                    ↓
                                              API 제공
                                                    ↓
                                                웹 시각화
```

##  주요 특징

- **실시간 처리**: MQTT와 웹 업로드를 통한 실시간 데이터 수집
- **유연한 파싱**: 다양한 CSV 형식 지원
- **메모리 효율성**: 온라인 알고리즘을 통한 효율적인 통계 계산
- **데이터 무결성**: 입력 검증 및 타입 변환
- **확장성**: 모듈화된 구조로 새로운 센서 추가 용이
- **실시간 시각화**: 웹 기반 대시보드를 통한 직관적인 데이터 표시

# 3. 실행 결과

![image](https://github.com/user-attachments/assets/5efecefc-2a0f-4e6d-b7f4-2cedd5ac42ca)

![image](https://github.com/user-attachments/assets/8d7fe877-c12d-475c-b4fd-eb58edd0b309)

![image](https://github.com/user-attachments/assets/4175d687-9b1d-4f56-bddc-cea5805ccadd)

![image](https://github.com/user-attachments/assets/dab00e16-6243-4aea-8b94-430d79206e42)

- 새로고침을 하지 않으면 task&core 그래프가 생성되지 않았습니다. 그래서 새로고침을 한 후에는 밑에 이미지들처럼 task&core 그래프가 생성되었습니다.

![image](https://github.com/user-attachments/assets/93586bc8-e4ec-400d-b813-9028362d9dec)

![image](https://github.com/user-attachments/assets/22902a74-8eb3-415d-b3e7-c0e571c3690b)



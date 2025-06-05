// mqtt-handler.js - 통합 버전
const mqtt     = require('mqtt');
const profiler = require('./profiler-instance');
const db       = require('./db');

const BROKER = process.env.MQTT_URI || 'mqtt://localhost:1883';
const TOPIC  = process.env.MQTT_TOPIC || 'roast/data';
const QOS    = parseInt(process.env.MQTT_QOS) || 1;

let client;
let isConnected = false;
let messageCount = 0;
let errorCount = 0;
let lastMessageTime = null;

// MQTT 클라이언트 연결
function connectMqtt() {
  console.log(`[MQTT] Attempting to connect to ${BROKER}`);
  
  client = mqtt.connect(BROKER, {
    reconnectPeriod: 5000,  // 5초마다 재연결 시도
    connectTimeout: 30000,  // 30초 연결 타임아웃
    clean: true,
    clientId: `roast-profiler-${Date.now()}`
  });

  // 연결 성공
  client.on('connect', () => {
    console.log(`[MQTT] Connected to ${BROKER}`);
    isConnected = true;
    errorCount = 0;
    
    // 토픽 구독
    client.subscribe(TOPIC, { qos: QOS }, (err) => {
      if (err) {
        console.error('[MQTT] Subscribe error:', err);
      } else {
        console.log(`[MQTT] Subscribed to topic: ${TOPIC} (QoS: ${QOS})`);
      }
    });
  });

  // 메시지 수신
  client.on('message', onMqttMessage);

  // 연결 끊김
  client.on('disconnect', () => {
    console.log('[MQTT] Disconnected');
    isConnected = false;
  });

  // 오프라인
  client.on('offline', () => {
    console.log('[MQTT] Client offline');
    isConnected = false;
  });

  // 에러 처리
  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
    isConnected = false;
    errorCount++;
  });

  // 재연결
  client.on('reconnect', () => {
    console.log('[MQTT] Attempting to reconnect...');
  });
}

// MQTT 메시지 처리 함수
async function onMqttMessage(topic, message) {
  let connection;
  const startTime = Date.now();
  
  try {
    // 메시지 파싱
    const payload = JSON.parse(message.toString());
    const now = new Date();
    
    console.log(`[MQTT] Received message from ${topic}:`, payload);
    
    // 유효성 검사
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid payload format');
    }

    // 센서 데이터 추출 및 검증
    const sensorData = {};
    const validSensors = ['ET', 'BT', 'ROR'];
    
    validSensors.forEach(sensor => {
      const value = payload[sensor];
      if (value !== undefined && value !== null) {
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          sensorData[sensor] = numValue;
        }
      }
    });

    // 유효한 센서 데이터가 없으면 스킵
    if (Object.keys(sensorData).length === 0) {
      console.warn('[MQTT] No valid sensor data found in payload');
      return;
    }

    // 데이터베이스 연결
    connection = await db.getConnection();
    
    // 병렬 처리를 위한 Promise 배열
    const dbPromises = [];

    // 1) mqtt_data 테이블에 센서별로 개별 저장
   // mqtt-handler.js 중 일부 발췌

    // 1) mqtt_data 테이블에 센서별로 개별 저장
    Object.entries(sensorData).forEach(([sensor, value]) => {
     // 수정 예시
      const insertPromise = connection.execute(
        `INSERT INTO mqtt_data (sensor, value, published_at) VALUES (?, ?, ?)`,
        [sensor, value, now]
      );

    });

    // 2) raw_data 테이블에 통합 레코드로 저장 (시계열 데이터용)
    const rawDataPromise = connection.execute(
      `INSERT INTO raw_data (time1, time2, ET, BT, ROR, event, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        now.toISOString(),
        now.getTime(),
        sensorData.ET || null,
        sensorData.BT || null, 
        sensorData.ROR || null,
        payload.event || payload.Event || null,
        'mqtt'
      ]
    );
    dbPromises.push(rawDataPromise);

    // 모든 DB 작업 실행
    await Promise.all(dbPromises);
    
    // 3) 메모리상의 프로파일러에 누적 (실시간 통계용)
    profiler.add(sensorData);

    // 통계 업데이트
    messageCount++;
    lastMessageTime = now;
    
    const processingTime = Date.now() - startTime;
    console.log(`[MQTT] Message processed successfully in ${processingTime}ms`);
    
    // 선택적: 주기적으로 통계 스냅샷을 DB에 저장
    if (messageCount % 100 === 0) {
      await saveStatsSnapshot(connection);
    }

  } catch (err) {
    errorCount++;
    console.error('[MQTT] Message processing error:', err.message);
    console.error('[MQTT] Raw message:', message.toString());
    
    // 에러율이 높으면 경고
    if (errorCount > 10 && messageCount > 0) {
      const errorRate = (errorCount / (messageCount + errorCount)) * 100;
      if (errorRate > 20) {
        console.warn(`[MQTT] High error rate detected: ${errorRate.toFixed(1)}%`);
      }
    }
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// 통계 스냅샷을 DB에 저장
async function saveStatsSnapshot(connection) {
  try {
    const stats = profiler.snapshot();
    const snapshotSql = `
      INSERT INTO stats_snapshot (sensor, min_val, max_val, avg_val, std_val, count_val, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), 'mqtt')
    `;
    
    const sensors = ['ET', 'BT', 'ROR'];
    const promises = sensors.map(sensor => {
      const s = stats[sensor];
      if (s && s.count > 0) {
        return connection.execute(snapshotSql, [
          sensor, s.min, s.max, s.avg, s.std, s.count
        ]);
      }
    }).filter(Boolean);

    if (promises.length > 0) {
      await Promise.all(promises);
      console.log(`[MQTT] Statistics snapshot saved (${messageCount} messages processed)`);
    }
  } catch (err) {
    console.error('[MQTT] Failed to save statistics snapshot:', err.message);
  }
}

// MQTT 상태 정보 반환
function getMqttStatus() {
  return {
    connected: isConnected,
    broker: BROKER,
    topic: TOPIC,
    qos: QOS,
    messageCount: messageCount,
    errorCount: errorCount,
    lastMessageTime: lastMessageTime,
    errorRate: messageCount + errorCount > 0 ? 
      ((errorCount / (messageCount + errorCount)) * 100).toFixed(2) + '%' : '0%'
  };
}

// 메시지 발행 (테스트용)
function publishTestMessage(data = {}) {
  if (!isConnected) {
    throw new Error('MQTT client not connected');
  }
  
  const testData = {
    ET: data.ET || Math.random() * 200 + 150,
    BT: data.BT || Math.random() * 250 + 100,
    ROR: data.ROR || Math.random() * 20 - 10,
    timestamp: new Date().toISOString(),
    ...data
  };
  
  client.publish(TOPIC, JSON.stringify(testData), { qos: QOS }, (err) => {
    if (err) {
      console.error('[MQTT] Publish error:', err);
    } else {
      console.log('[MQTT] Test message published:', testData);
    }
  });
  
  return testData;
}

// 연결 해제
function disconnect() {
  if (client) {
    console.log('[MQTT] Disconnecting...');
    client.end();
    isConnected = false;
  }
}

// 정리 작업
process.on('SIGINT', () => {
  console.log('[MQTT] Received SIGINT, closing MQTT connection...');
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[MQTT] Received SIGTERM, closing MQTT connection...');
  disconnect();
  process.exit(0);
});

// 애플리케이션 시작시 MQTT 연결
connectMqtt();

// 모듈 익스포트
module.exports = {
  client,
  getMqttStatus,
  publishTestMessage,
  disconnect,
  isConnected: () => isConnected,
  getStats: () => ({
    messageCount,
    errorCount,
    lastMessageTime
  })
};
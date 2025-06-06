// server.js
console.log('>>> server.js 시작');
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const { parse } = require('csv-parse/sync');
const cors    = require('cors');
const profiler = require('./profiler-instance');
const db      = require('./db');          // DB 모듈

const app      = express();
const upload   = multer({ dest: 'uploads/' });   // tmp 저장
const mqttHandler = require('./mqtt-handler');

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (public 폴더)
app.use(express.static('public'));

/* 1) 파일 업로드 엔드포인트 ---------------------------- */
app.post('/upload', upload.single('datafile'), async (req, res) => {
  let connection;
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', msg: '파일이 업로드되지 않았습니다.' });
    }

    // ① CSV/TXT 읽기
    const filePath = req.file.path;
    const raw = fs.readFileSync(filePath, 'utf8');
    
    if (!raw.trim()) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ status: 'error', msg: '빈 파일입니다.' });
    }

    console.log('Raw file content preview:', raw.substring(0, 500));

    // ② CSV 파싱 - 여러 구분자 시도 (강화된 파싱 로직)
    let records = [];
    let parseError = null;
    
    // 탭 구분자로 먼저 시도
    try {
      records = parse(raw, {
        from_line: 2,
        columns: true,
        trim: true,
        delimiter: '\t',
        relax_column_count: true,
        skip_empty_lines: true
      });
      console.log('Tab-delimited parsing successful, records:', records.length);
    } catch (tabError) {
      console.log('Tab parsing failed, trying comma:', tabError.message);
      
      // 쉼표 구분자로 시도
      try {
        records = parse(raw, {
          from_line: 2,
          columns: true,
          trim: true,
          delimiter: ',',
          relax_column_count: true,
          skip_empty_lines: true
        });
        console.log('Comma-delimited parsing successful, records:', records.length);
      } catch (commaError) {
        console.log('Comma parsing failed, trying auto-detect:', commaError.message);
        
        // 자동 구분자 감지로 시도
        try {
          records = parse(raw, {
            from_line: 2,
            columns: true,
            trim: true,
            relax_column_count: true,
            skip_empty_lines: true
          });
          console.log('Auto-detect parsing successful, records:', records.length);
        } catch (autoError) {
          parseError = autoError;
        }
      }
    }

    if (parseError || records.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ 
        status: 'error', 
        msg: `CSV 파싱 실패: ${parseError ? parseError.message : '데이터가 없습니다'}` 
      });
    }

    console.log('Sample record:', records[0]);

    // DB 커넥션 얻기
    connection = await db.getConnection();

    //task 번호 계산
    const [[{ maxTask }]] = await connection.execute(
      'SELECT COALESCE(MAX(task_num),0) AS maxTask FROM raw_data'
    );
    const taskNum = maxTask + 1;
    const coreNum = 0;

    // Insert 문 준비: raw_data 테이블에 시간, ET, BT, ROR, event를 순차적으로 넣음
    const insertSql = `
      INSERT INTO raw_data 
       (task_num, core_num, time1, time2, ET, BT, ROR, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // ③ 각 레코드를 Profiler에 누적 + DB에 저장
    let validCount = 0;
    const insertPromises = [];

    records.forEach((r, index) => {
      try {
        // 다양한 컬럼명 패턴 지원
        const etValue = parseFloat(r.ET || r.EnvTemp || r.Environment_Temp || r.et || r.envtemp || 0);
        const btValue = parseFloat(r.BT || r.BeanTemp || r.Bean_Temp || r.bt || r.beantemp || 0);
        const rorValue = parseFloat(r.ROR || r.RoR || r.Rate_of_Rise || r.ror || 0);

        // 시간 및 이벤트 데이터
        const t1 = r.Time1 || r.time1 || r.Time || r.time || null;
        const t2 = r.Time2 || r.time2 || null;
        const evt = r.Event || r.event || r.EVENT || null;

        // 유효한 숫자인지 확인
        const record = {};
        const et = !isNaN(etValue) && etValue !== 0 ? etValue : null;
        const bt = !isNaN(btValue) && btValue !== 0 ? btValue : null;
        const ror = !isNaN(rorValue) && rorValue !== 0 ? rorValue : null;

        if (et !== null) record.ET = et;
        if (bt !== null) record.BT = bt;
        if (ror !== null) record.ROR = ror;

        // 최소한 하나의 유효한 값이 있으면 처리
        if (Object.keys(record).length > 0) {
          // Profiler에 누적
          profiler.add(record);
          validCount++;

          // DB에 저장할 Promise 추가
          insertPromises.push(
            connection.execute(
              insertSql,
               [taskNum, coreNum, row.Time1, row.Time2, row.et, row.bt, row.ror, row.Event])
          );
        }
      } catch (recordError) {
        console.log(`Record ${index} processing error:`, recordError.message);
      }
    });

    if (validCount === 0) {
      fs.unlinkSync(filePath);
      if (connection) connection.release();
      return res.status(400).json({ 
        status: 'error', 
        msg: '유효한 데이터가 없습니다. ET, BT, ROR 컬럼을 확인해주세요.' 
      });
    }

    // DB에 모든 INSERT 실행
    await Promise.all(insertPromises);
    console.log(`Successfully inserted ${validCount} records to database`);

    // ④ 통계 스냅샷 반환
    const stats = profiler.snapshot();

    // 동시에 stats_snapshot 테이블에도 저장
    const snapshotSql = `
      INSERT INTO stats_snapshot (
        sensor, min_val, max_val, avg_val, std_val, count_val, snapshot_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;

    const sensors = ['ET', 'BT', 'ROR'];
    const snapshotPromises = sensors.map(sensor => {
      const s = stats[sensor];
      if (s && s.count > 0) {
        return connection.execute(snapshotSql, [
          sensor, s.min, s.max, s.avg, s.std, s.count
        ]);
      }
    }).filter(Boolean);

    if (snapshotPromises.length > 0) {
      await Promise.all(snapshotPromises);
      console.log('Statistics snapshot saved to database');
    }

    // ⑤ 임시파일 삭제
    fs.unlinkSync(filePath);
    
    res.json({ 
      status: 'ok', 
      stats: stats, 
      count: validCount,
      totalRows: records.length 
    });

  } catch (err) {
    console.error('Upload error:', err);
    
    // 임시파일 정리
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Failed to delete temp file:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      status: 'error', 
      msg: `서버 오류: ${err.message}` 
    });
  } finally {
    if (connection) connection.release();
  }
});

/* 2) 누적 통계 조회 ---------------------------- */
app.get('/stats', async (_, res) => {
  try {
    // 메모리상의 profiler.snapshot()을 우선 사용
    const memoryStats = profiler.snapshot();
    
    res.json(memoryStats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

/* 3) Task/Core 별 통계 조회 (새로 추가) ---------------------------- */
app.get('/task-core-stats', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    
    // Task별 통계
    const [taskStats] = await connection.execute(`
      SELECT 
        task_num,
        COUNT(*) as count,
        MIN(ET) as min_et, MAX(ET) as max_et, AVG(ET) as avg_et,
        MIN(BT) as min_bt, MAX(BT) as max_bt, AVG(BT) as avg_bt,
        MIN(ROR) as min_ror, MAX(ROR) as max_ror, AVG(ROR) as avg_ror
      FROM raw_data 
      WHERE task_num IS NOT NULL
      GROUP BY task_num
      ORDER BY task_num
    `);

    // Core별 통계
    const [coreStats] = await connection.execute(`
      SELECT 
        core_num,
        COUNT(*) as count,
        MIN(ET) as min_et, MAX(ET) as max_et, AVG(ET) as avg_et,
        MIN(BT) as min_bt, MAX(BT) as max_bt, AVG(BT) as avg_bt,
        MIN(ROR) as min_ror, MAX(ROR) as max_ror, AVG(ROR) as avg_ror
      FROM raw_data 
      WHERE core_num IS NOT NULL
      GROUP BY core_num
      ORDER BY core_num
    `);

    res.json({
      status: 'ok',
      taskStats: taskStats,
      coreStats: coreStats
    });
  } catch (err) {
    console.error('Task/Core stats error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 4) Task/Core 데이터 시계열 조회 (새로 추가) ---------------------------- */
app.get('/task-core-timeseries', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    
    const [rows] = await connection.execute(`
      SELECT 
        id, time1, task_num, core_num, ET, BT, ROR,
        ROW_NUMBER() OVER (ORDER BY id) as sequence
      FROM raw_data 
      WHERE task_num IS NOT NULL OR core_num IS NOT NULL
      ORDER BY id
      LIMIT 1000
    `);
    
    res.json({
      status: 'ok',
      data: rows,
      count: rows.length
    });
  } catch (err) {
    console.error('Task/Core timeseries error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 3) DB에서 원시 데이터 조회 ---------------------------- */
app.get('/raw-data', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const [rows] = await connection.execute(`
      SELECT * FROM raw_data 
      ORDER BY id DESC 
      LIMIT 1000
    `);
    
    res.json({
      status: 'ok',
      data: rows,
      count: rows.length
    });
  } catch (err) {
    console.error('Raw data query error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 4) DB에서 통계 스냅샷 이력 조회 ---------------------------- */
app.get('/stats-history', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const [rows] = await connection.execute(`
      SELECT * FROM stats_snapshot 
      ORDER BY snapshot_at DESC 
      LIMIT 50
    `);
    
    res.json({
      status: 'ok',
      data: rows,
      count: rows.length
    });
  } catch (err) {
    console.error('Stats history query error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 5) 데이터 리셋 (개발용) ---------------------------- */
app.delete('/reset-data', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    
    // 테이블 데이터 삭제
    await connection.execute('DELETE FROM raw_data');
    await connection.execute('DELETE FROM stats_snapshot');
    
    // 메모리상의 profiler도 리셋
    profiler.reset();
    
    res.json({ 
      status: 'ok', 
      msg: '모든 데이터가 리셋되었습니다.' 
    });
  } catch (err) {
    console.error('Reset data error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 6) MQTT 상태 조회 ---------------------------- */
app.get('/mqtt/status', (_, res) => {
  try {
    const status = mqttHandler.getMqttStatus();
    res.json({
      status: 'ok',
      mqtt: status
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

/* 7) MQTT 테스트 메시지 발행 ---------------------------- */
app.post('/mqtt/test', (req, res) => {
  try {
    if (!mqttHandler.isConnected()) {
      return res.status(400).json({ 
        status: 'error', 
        msg: 'MQTT client not connected' 
      });
    }
    
    const testData = mqttHandler.publishTestMessage(req.body);
    res.json({
      status: 'ok',
      message: 'Test message published',
      data: testData
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

/* 8) MQTT 데이터 조회 ---------------------------- */
app.get('/mqtt/data', async (_, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const [rows] = await connection.execute(`
      SELECT * FROM mqtt_data 
      ORDER BY published_at DESC 
      LIMIT 500
    `);
    
    res.json({
      status: 'ok',
      data: rows,
      count: rows.length
    });
  } catch (err) {
    console.error('MQTT data query error:', err);
    res.status(500).json({ status: 'error', msg: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* 9) 헬스 체크 ---------------------------- */
app.get('/api/health', async (_, res) => {
  try {
    // DB 연결 테스트
    const connection = await db.getConnection();
    const [[{ maxTask }]] = await connection.execute(
      'SELECT COALESCE(MAX(task_num),0) AS maxTask FROM raw_data'
    );
    const taskNum = maxTask + 1;
    const coreNum = 0;
    await connection.execute('SELECT 1');
    connection.release();
    
    // MQTT 상태 확인
    const mqttStatus = mqttHandler.getMqttStatus();
    
    res.json({
      status: 'ok',
      message: 'Roast-Profiler REST API v1',
      database: 'connected',
      mqtt: mqttStatus,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Service health check failed',
      error: err.message
    });
  }
});

/* API 문서 경로 - 루트와 구분하기 위해 /api 경로 사용 */
app.get('/api', (_, res) => {
  res.send(`
    <h1>Roast-Profiler REST API v1</h1>
    <p>Available endpoints:</p>
    <ul>
      <li><strong>File Upload:</strong></li>
      <li>&nbsp;&nbsp;POST /upload - Upload CSV file</li>
      <li><strong>Statistics:</strong></li>
      <li>&nbsp;&nbsp;GET /stats - Get current statistics</li>
      <li>&nbsp;&nbsp;GET /stats-history - Get statistics history</li>
      <li><strong>Data:</strong></li>
      <li>&nbsp;&nbsp;GET /raw-data - Get raw data from DB</li>
      <li>&nbsp;&nbsp;DELETE /reset-data - Reset all data</li>
      <li><strong>MQTT:</strong></li>
      <li>&nbsp;&nbsp;GET /mqtt/status - Get MQTT connection status</li>
      <li>&nbsp;&nbsp;POST /mqtt/test - Publish test message</li>
      <li>&nbsp;&nbsp;GET /mqtt/data - Get MQTT data from DB</li>
      <li><strong>System:</strong></li>
      <li>&nbsp;&nbsp;GET /api/health - Health check</li>
    </ul>
    <p><a href="/">← 메인 웹 애플리케이션으로 돌아가기</a></p>
  `);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HTTP server listening on :${PORT}`);
  console.log(`Web UI available at: http://localhost:${PORT}`);
  console.log(`API documentation at: http://localhost:${PORT}/api`);
  console.log('API endpoints ready for roast profiling data');
});

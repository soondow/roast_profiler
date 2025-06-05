// db.js
const mysql = require('mysql2/promise');

// 환경 변수나 설정 파일에서 정보를 읽어도 되고, 직접 하드코딩해도 됩니다.
const pool = mysql.createPool({
  host: 'localhost',
  port: 3306,
  user: 'test',
  password: 'test_password',
  database: 'roastdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;

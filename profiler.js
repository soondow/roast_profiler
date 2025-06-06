// profiler.js

class RunningStats {
  constructor() {
    this.n = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  add(x) {
    this.n += 1;
    this.sum += x;
    this.sumSq += x * x;
    this.min = Math.min(this.min, x);
    this.max = Math.max(this.max, x);
  }

  get avg() {
    return this.n ? this.sum / this.n : 0;
  }

  get std() {
    if (this.n < 2) return 0;
    return Math.sqrt((this.sumSq / this.n) - this.avg ** 2);
  }

  snapshot() {
    return {
      min: this.min === Number.POSITIVE_INFINITY ? null : this.min,
      max: this.max === Number.NEGATIVE_INFINITY ? null : this.max,
      avg: this.avg,
      std: this.std,
      count: this.n
    };
  }

  reset() {
    this.n = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }
}

class Profiler {
  constructor() {
    // 센서 컬럼별 개별 통계
    this.stats = {
      ET:  new RunningStats(),
      BT:  new RunningStats(),
      ROR: new RunningStats()
    };
  }

  /** record = { ET, BT, ROR, … } */
  add(record) {
    ['ET', 'BT', 'ROR'].forEach(k => {
      if (record[k] !== undefined && record[k] !== null) {
        const v = Number(record[k]);
        if (!isNaN(v)) {
          this.stats[k].add(v);
        }
      }
    });
  }

  snapshot() {
    return {
      ET:  this.stats.ET.snapshot(),
      BT:  this.stats.BT.snapshot(),
      ROR: this.stats.ROR.snapshot()
    };
  }

  reset() {
    // stats 객체 전체를 새로 초기화하지 않고, 각 RunningStats만 reset
    this.stats.ET.reset();
    this.stats.BT.reset();
    this.stats.ROR.reset();
  }
}

module.exports = Profiler;

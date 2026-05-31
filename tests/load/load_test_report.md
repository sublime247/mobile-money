# Load Test Report Template

## 1. Test Overview

- **Test Date**:
- **Environment**: [Development/Staging]
- **Baseline RPS**:
- **Tool Used**: [k6/Autocannon]
- **Target Version**: [Branch/Commit Hash]

---

## 2. Test Execution

| Scenario      | VUs  | Duration | Requests | Errors |
| :------------ | :--- | :------- | :------- | :----- |
| Health Checks | 10   | 30s      |          |        |
| Read Load     | 0-20 | 2m       |          |        |
| Write Load    | 5    | 2m       |          |        |

---

## 3. Results Summary

### Latency (ms)

| Percentile | Value | Target   | Pass/Fail |
| :--------- | :---- | :------- | :-------- |
| **p90**    |       | < 200ms  |           |
| **p95**    |       | < 500ms  |           |
| **p99**    |       | < 1000ms |           |

### Throughput

- **Actual RPS**:
- **Target RPS**: 50
- **Status**:

---

## 4. Observations & Findings

- [ ] **Bottlenecks surfaced?** (e.g., Database lock, CPU saturating)
- [ ] **Error types?** (e.g., 504 Gateway Timeout, 500 Internal Error)
- [ ] **Resource Consumption**: [CPU usage during test]

---

## 5. Decision & Recommendations

- [ ] **Action required?** (e.g., Increase DB pool size, Optimize `/api/reports`)
- [ ] **Adjustment to load parameters?** (e.g., Increase VUs for next run)

---

## 6. Review Effectiveness Summary

- [ ] **Test covered critical paths?** Yes/No
- [ ] **Test produced actionable data?** Yes/No
- [ ] **Test environment was representative?** Yes/No

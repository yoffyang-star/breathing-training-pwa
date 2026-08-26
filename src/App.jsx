import { useEffect, useMemo, useState } from 'react'
import './App.css'

/* =========================================================
   研究設定
   ========================================================= */

const TOTAL_DAYS = 28

// 正式研究：10 分鐘 = 600 秒
// 目前測試版：10 秒
// 最終正式測試前，只需要把 10 改成 600
const TRAINING_SECONDS = 10

// 5 秒吸氣 + 5 秒吐氣
const BREATH_SECONDS = 5

// 評估日：Day 1、Day 14、Day 28
const EVALUATION_DAYS = [1, 14, 28]

// 臨床重要差異（MCID）
// 目前以 SBP / DBP 下降 5 mmHg 作為研究後台的判定門檻。
// 正式論文可依研究計畫或文獻決定最終門檻。
const MCID_SBP = 5
const MCID_DBP = 5

const STORAGE_KEYS = {
  study: 'breathing-study-settings',
  records: 'breathing-study-records',
}

/* =========================================================
   日期工具
   ========================================================= */

function getDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDisplayDate(dateKey) {
  if (!dateKey) return ''
  const [year, month, day] = dateKey.split('-')
  return `${year} / ${month} / ${day}`
}

function formatShortDate(dateKey) {
  if (!dateKey) return ''
  const [, month, day] = dateKey.split('-')
  return `${Number(month)}/${Number(day)}`
}

function isEvaluationDay(day) {
  return EVALUATION_DAYS.includes(day)
}

function getStudyDayFromDate(startDate, dateKey) {
  if (!startDate || !dateKey) return null

  const start = new Date(`${startDate}T00:00:00`)
  const date = new Date(`${dateKey}T00:00:00`)

  const difference = Math.floor(
    (date - start) / (1000 * 60 * 60 * 24)
  )

  if (difference < 0 || difference >= TOTAL_DAYS) return null

  return difference + 1
}

/* =========================================================
   研究後台統計工具
   ========================================================= */

function getChange(pre, post) {
  if (typeof pre !== 'number' || typeof post !== 'number') {
    return null
  }

  // 負值代表下降，例如 140 → 135 = -5 mmHg
  return post - pre
}

function mean(values) {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleSD(values) {
  if (values.length < 2) return null
  const avg = mean(values)
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
    (values.length - 1)
  return Math.sqrt(variance)
}

function formatNumber(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—'
}

function calculateResearchAnalysis(studyRows) {
  const evaluationData = studyRows
    .filter((row) => row.evaluation)
    .map((row) => ({
      day: row.day,
      pre: row.record?.pre || null,
      post: row.record?.post || null,
      post30: row.record?.post30 || null,
    }))

  const sbpChanges = evaluationData
    .map((item) => getChange(item.pre?.sbp, item.post?.sbp))
    .filter((value) => value !== null)

  const dbpChanges = evaluationData
    .map((item) => getChange(item.pre?.dbp, item.post?.dbp))
    .filter((value) => value !== null)

  const hrChanges = evaluationData
    .map((item) => getChange(item.pre?.hr, item.post?.hr))
    .filter((value) => value !== null)

  const sbpMean = mean(sbpChanges)
  const dbpMean = mean(dbpChanges)
  const hrMean = mean(hrChanges)

  // 探索性 paired effect size：Cohen's dz = 平均變化 / 變化量 SD
  // 注意：這不是正式 GEE 的效果量。正式研究仍應以 GEE 模型結果為準。
  const sbpSD = sampleSD(sbpChanges)
  const dbpSD = sampleSD(dbpChanges)
  const hrSD = sampleSD(hrChanges)

  const sbpEffectSize =
    sbpMean !== null && sbpSD && sbpSD > 0
      ? Math.abs(sbpMean / sbpSD)
      : null

  const dbpEffectSize =
    dbpMean !== null && dbpSD && dbpSD > 0
      ? Math.abs(dbpMean / dbpSD)
      : null

  const hrEffectSize =
    hrMean !== null && hrSD && hrSD > 0
      ? Math.abs(hrMean / hrSD)
      : null

  const sbpMcidCount = sbpChanges.filter(
    (change) => change <= -MCID_SBP
  ).length

  const dbpMcidCount = dbpChanges.filter(
    (change) => change <= -MCID_DBP
  ).length

  return {
    evaluationData,
    sbp: {
      meanChange: sbpMean,
      effectSize: sbpEffectSize,
      mcid: MCID_SBP,
      mcidCount: sbpMcidCount,
      n: sbpChanges.length,
    },
    dbp: {
      meanChange: dbpMean,
      effectSize: dbpEffectSize,
      mcid: MCID_DBP,
      mcidCount: dbpMcidCount,
      n: dbpChanges.length,
    },
    hr: {
      meanChange: hrMean,
      effectSize: hrEffectSize,
      n: hrChanges.length,
    },
  }
}

/* =========================================================
   LocalStorage
   ========================================================= */

function loadStudySettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.study)
    if (!saved) return null
    return JSON.parse(saved)
  } catch {
    return null
  }
}

function loadRecords() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.records)
    if (!saved) return {}
    return JSON.parse(saved)
  } catch {
    return {}
  }
}

function saveRecords(records) {
  localStorage.setItem(
    STORAGE_KEYS.records,
    JSON.stringify(records)
  )
}

/* =========================================================
   App
   ========================================================= */


/* =========================================================
   研究者登入
   教授展示版：/researcher
   ========================================================= */

function ResearcherLogin({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(event) {
    event.preventDefault()

    if (password === 'researcher2026') {
      setError('')
      onLogin()
      return
    }

    setError('研究者密碼錯誤，請重新輸入。')
  }

  return (
    <main className="researcher-login-page">
      <section className="researcher-login-card">
        <div className="login-brand">
          5–5 BREATHING TRAINING
        </div>

        <div className="login-icon" aria-hidden="true">
          🔐
        </div>

        <h1>研究者後台</h1>

        <p>
          Researcher Dashboard
          <br />
          此頁面僅供研究者使用
        </p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="researcher-password">
            研究者密碼
          </label>

          <input
            id="researcher-password"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setError('')
            }}
            placeholder="請輸入研究者密碼"
            autoComplete="off"
            autoFocus
          />

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="primary-button"
          >
            登入研究者後台
          </button>
        </form>

        <div className="login-note">
          本頁為教授展示版研究者入口
        </div>

        <button
          type="button"
          className="secondary-button"
          style={{ marginTop: '14px', width: '100%' }}
          onClick={() => window.location.assign('/')}
        >
          返回受試者端
        </button>
      </section>
    </main>
  )
}

function App() {
  // Professor demo: researcher access is separated at /researcher.
  const isResearcherPath = window.location.pathname === '/researcher'
  const [researcherLoggedIn, setResearcherLoggedIn] = useState(false)
  const [study, setStudy] = useState(() => loadStudySettings())
  const [records, setRecords] = useState(() => loadRecords())

  const [page, setPage] = useState(() => {
    const saved = loadStudySettings()
    return saved ? 'pre' : 'setup'
  })

  const [participantId, setParticipantId] = useState(() => {
    const saved = loadStudySettings()
    return saved?.participantId || ''
  })

  const todayKey = getDateKey()
  const todayRecord = records[todayKey] || null
  const startDate = study?.startDate || null

  const studyDay = useMemo(() => {
    if (!startDate) return 1

    const start = new Date(`${startDate}T00:00:00`)
    const today = new Date()

    start.setHours(0, 0, 0, 0)
    today.setHours(0, 0, 0, 0)

    const difference = Math.floor(
      (today - start) / (1000 * 60 * 60 * 24)
    )

    return Math.min(
      Math.max(difference + 1, 1),
      TOTAL_DAYS
    )
  }, [startDate])

  const evaluationDay = isEvaluationDay(studyDay)

  function refreshLocalData() {
    setStudy(loadStudySettings())
    setRecords(loadRecords())
  }

  function updateTodayRecord(updates) {
    const current = records[todayKey] || {}

    const updated = {
      ...current,
      ...updates,
    }

    const newRecords = {
      ...records,
      [todayKey]: updated,
    }

    setRecords(newRecords)
    saveRecords(newRecords)

    return updated
  }

  /* =======================================================
     研究開始
     ======================================================= */

  function startStudy() {
    const id = participantId.trim()

    if (!id) {
      alert('請先輸入研究編號，例如 P001')
      return
    }

    const existing = loadStudySettings()

    const newStudy = {
      participantId: id,
      startDate: existing?.startDate || todayKey,
    }

    localStorage.setItem(
      STORAGE_KEYS.study,
      JSON.stringify(newStudy)
    )

    setStudy(newStudy)
    setParticipantId(id)
    setPage('pre')
  }

  /* =======================================================
     重新開始研究
     ======================================================= */

  function resetStudy() {
    const confirmed = window.confirm(
      '確定要清除目前研究資料並重新開始嗎？此動作會刪除本機測試資料。'
    )

    if (!confirmed) return

    localStorage.removeItem(STORAGE_KEYS.study)
    localStorage.removeItem(STORAGE_KEYS.records)

    setStudy(null)
    setRecords({})
    setParticipantId('')
    setPage('setup')
  }

  /* =======================================================
     儲存測量
     ======================================================= */

  function savePreMeasurement(sbp, dbp, hr) {
    updateTodayRecord({
      date: todayKey,
      participantId,
      day: studyDay,
      pre: {
        sbp,
        dbp,
        hr,
        time: new Date().toISOString(),
      },
    })
  }

  function savePostMeasurement(sbp, dbp, hr) {
    updateTodayRecord({
      post: {
        sbp,
        dbp,
        hr,
        time: new Date().toISOString(),
      },
    })
  }

  function savePost30Measurement(sbp, dbp, hr) {
    updateTodayRecord({
      post30: {
        sbp,
        dbp,
        hr,
        time: new Date().toISOString(),
      },
    })
  }

  function completeTraining() {
    updateTodayRecord({
      completed: true,
      completedAt: new Date().toISOString(),
      trainingSeconds: TRAINING_SECONDS,
    })
  }

  /* =======================================================
     Setup
     ======================================================= */

  if (page === 'setup') {
    return (
      <main className="app">
        <section className="hero setup-page">
          <p className="subtitle">5–5 BREATHING TRAINING</p>

          <h1>研究資料設定</h1>

          <p className="description">
            請輸入您的研究編號
            <br />
            開始 4 週呼吸訓練
          </p>

          <label className="input-label">研究編號</label>

          <input
            className="study-input"
            value={participantId}
            onChange={(e) => setParticipantId(e.target.value)}
            placeholder="例如 P001"
          />

          <div className="info-box">
            <span>研究期間</span>
            <strong>28 天</strong>
          </div>

          <div className="info-box">
            <span>每日訓練</span>
            <strong>10 分鐘 × 1 次</strong>
          </div>

          <button
            className="start-button"
            onClick={startStudy}
          >
            開始研究
          </button>

          <button
            className="secondary-button"
            onClick={() => {
              refreshLocalData()
              setPage('researcher')
            }}
          >
            研究者後台
          </button>
        </section>
      </main>
    )
  }

  /* =======================================================
     研究者後台
     ======================================================= */

  if (isResearcherPath && !researcherLoggedIn) {
    return (
      <ResearcherLogin
        onLogin={() => {
          setResearcherLoggedIn(true)
          refreshLocalData()
          setPage('researcher')
        }}
      />
    )
  }

  if (page === 'researcher') {
    return (
      <ResearcherDashboard
        study={study}
        records={records}
        onRefresh={refreshLocalData}
        onBack={() => window.location.assign('/')}
        onReset={resetStudy}
      />
    )
  }

  /* =======================================================
     訓練前測量
     ======================================================= */

  if (page === 'pre') {
    return (
      <MeasurementPage
        title="訓練前測量"
        subtitle={`Day ${studyDay}`}
        description="請測量血壓與心率"
        measurement={todayRecord?.pre}
        buttonText="開始呼吸訓練"
        onComplete={(sbp, dbp, hr) => {
          savePreMeasurement(sbp, dbp, hr)
          setPage('training')
        }}
      />
    )
  }

  /* =======================================================
     呼吸訓練
     ======================================================= */

  if (page === 'training') {
    return (
      <TrainingPage
        studyDay={studyDay}
        totalSeconds={TRAINING_SECONDS}
        breathSeconds={BREATH_SECONDS}
        onFinish={() => {
          completeTraining()
          setPage('post')
        }}
        onCancel={() => {
          const confirmed = window.confirm(
            '確定要提前結束本次訓練嗎？未完成將不會記錄為今日完成。'
          )

          if (confirmed) {
            setPage('pre')
          }
        }}
      />
    )
  }

  /* =======================================================
     訓練後立即測量
     ======================================================= */

  if (page === 'post') {
    return (
      <MeasurementPage
        title="訓練後立即測量"
        subtitle={`Day ${studyDay}`}
        description="請立即測量血壓與心率"
        measurement={todayRecord?.post}
        buttonText={
          evaluationDay
            ? '下一步：30 分鐘後測量'
            : '完成今日訓練'
        }
        onComplete={(sbp, dbp, hr) => {
          savePostMeasurement(sbp, dbp, hr)

          if (evaluationDay) {
            setPage('post30')
          } else {
            setPage('complete')
          }
        }}
      />
    )
  }

  /* =======================================================
     30 分鐘後測量
     ======================================================= */

  if (page === 'post30') {
    return (
      <MeasurementPage
        title="30 分鐘後測量"
        subtitle={`Day ${studyDay} 評估日`}
        description="請測量血壓與心率"
        measurement={todayRecord?.post30}
        buttonText="完成今日評估"
        onComplete={(sbp, dbp, hr) => {
          savePost30Measurement(sbp, dbp, hr)
          setPage('complete')
        }}
      />
    )
  }

  /* =======================================================
     今日完成
     ======================================================= */

  if (page === 'complete') {
    return (
      <CompletePage
        studyDay={studyDay}
        evaluationDay={evaluationDay}
        onHome={() => setPage('history')}
      />
    )
  }

  /* =======================================================
     訓練紀錄
     ======================================================= */

  if (page === 'history') {
    const last7Days = []

    for (let i = 6; i >= 0; i--) {
      const date = new Date()
      date.setDate(date.getDate() - i)

      const key = getDateKey(date)
      const record = records[key] || null

      last7Days.push({
        date,
        key,
        record,
        completed: record?.completed === true,
      })
    }

    const completed7Days = last7Days.filter(
      (day) => day.completed
    ).length

    const completionRate7 = (completed7Days / 7) * 100

    let totalCompletedDays = 0

    if (startDate) {
      for (let day = 1; day <= TOTAL_DAYS; day++) {
        const date = new Date(`${startDate}T00:00:00`)
        date.setDate(date.getDate() + (day - 1))

        const key = getDateKey(date)
        const record = records[key]

        if (record?.completed === true) {
          totalCompletedDays++
        }
      }
    }

    const studyCompletionRate =
      (totalCompletedDays / TOTAL_DAYS) * 100

    let streak = 0

    for (let i = 0; i < TOTAL_DAYS; i++) {
      const date = new Date()
      date.setDate(date.getDate() - i)

      const key = getDateKey(date)
      const record = records[key]

      if (record?.completed === true) {
        streak++
      } else {
        break
      }
    }

    return (
      <main className="app">
        <section className="hero history-page">
          <p className="subtitle">5–5 BREATHING TRAINING</p>

          <h1>我的訓練紀錄</h1>

          <div className="study-progress-card">
            <div className="record-section-title">
              研究進度
            </div>

            <div className="study-progress-number">
              Day {studyDay}
              <span>/ {TOTAL_DAYS}</span>
            </div>

            <div className="study-progress-bar">
              <div
                className="study-progress-fill"
                style={{
                  width: `${(studyDay / TOTAL_DAYS) * 100}%`,
                }}
              />
            </div>

            <div className="study-progress-text">
              已完成 {totalCompletedDays} / {TOTAL_DAYS} 天
              {'　'}
              {studyCompletionRate.toFixed(1)}%
            </div>
          </div>

          <div className="rate-section">
            <span className="rate-title">
              最近 7 天完成率
            </span>

            <strong className="rate-number">
              {completionRate7.toFixed(1)}%
            </strong>

            <div className="rate-bar">
              <div
                className="rate-fill"
                style={{
                  width: `${completionRate7}%`,
                }}
              />
            </div>
          </div>

          <div className="seven-day-card">
            <h2>最近 7 天</h2>

            <div className="seven-day-grid">
              {last7Days.map((day) => (
                <div className="day-item" key={day.key}>
                  <span className="day-date">
                    {day.date.getMonth() + 1}/
                    {day.date.getDate()}
                  </span>

                  <div
                    className={
                      day.completed
                        ? 'day-status completed'
                        : 'day-status incomplete'
                    }
                  >
                    {day.completed ? '✓' : '—'}
                  </div>

                  <span className="day-label">
                    {day.completed ? '完成' : '未完成'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="streak-card">
            <div className="streak-icon">🔥</div>

            <div>
              <span>目前連續完成</span>
              <strong>{streak} 天</strong>
            </div>
          </div>

          <div className="today-record-card">
            <div className="record-section-title">
              今日測量紀錄
            </div>

            <div className="record-day">
              Day {studyDay}
            </div>

            <MeasurementRecord
              title="訓練前"
              data={todayRecord?.pre}
            />

            <MeasurementRecord
              title="訓練後立即"
              data={todayRecord?.post}
            />

            {evaluationDay && (
              <MeasurementRecord
                title="30 分鐘後"
                data={todayRecord?.post30}
              />
            )}
          </div>

          <p className="record-note">
            完成一次完整
            {TRAINING_SECONDS >= 600
              ? ' 10 分鐘 '
              : ' 測試版訓練 '}
            呼吸訓練，即記為當日完成。
            <br />
            30 分鐘後測量僅於 Day 1、Day 14、Day 28 進行。
          </p>

          <button
            className="start-button"
            onClick={() => setPage('pre')}
          >
            返回今日訓練
          </button>

          <button
            className="secondary-button danger-button"
            onClick={resetStudy}
          >
            清除測試資料
          </button>
        </section>
      </main>
    )
  }

  return null
}

/* =========================================================
   血壓測量頁
   ========================================================= */

function MeasurementPage({
  title,
  subtitle,
  description,
  measurement,
  buttonText,
  onComplete,
}) {
  const [sbp, setSbp] = useState(measurement?.sbp || '')
  const [dbp, setDbp] = useState(measurement?.dbp || '')
  const [hr, setHr] = useState(measurement?.hr || '')

  function handleSubmit() {
    if (!sbp || !dbp || !hr) {
      alert('請完整輸入收縮壓、舒張壓與心率。')
      return
    }

    onComplete(
      Number(sbp),
      Number(dbp),
      Number(hr)
    )
  }

  return (
    <main className="app">
      <section className="hero measurement-page">
        <p className="subtitle">5–5 BREATHING TRAINING</p>

        <div className="day-badge">{subtitle}</div>

        <h1>{title}</h1>

        <p className="description">{description}</p>

        <div className="measurement-card">
          <div className="measurement-heading">
            {title.replace('測量', '')}
          </div>

          <div className="vital-input-grid">
            <div>
              <label>收縮壓 SBP</label>

              <input
                type="number"
                inputMode="numeric"
                value={sbp}
                onChange={(e) => setSbp(e.target.value)}
                placeholder="例如 140"
              />
            </div>

            <div>
              <label>舒張壓 DBP</label>

              <input
                type="number"
                inputMode="numeric"
                value={dbp}
                onChange={(e) => setDbp(e.target.value)}
                placeholder="例如 85"
              />
            </div>
          </div>

          <div className="single-input">
            <label>心率 HR</label>

            <input
              type="number"
              inputMode="numeric"
              value={hr}
              onChange={(e) => setHr(e.target.value)}
              placeholder="例如 72"
            />
          </div>
        </div>

        <button
          className="start-button"
          onClick={handleSubmit}
        >
          {buttonText}
        </button>
      </section>
    </main>
  )
}

/* =========================================================
   呼吸訓練頁
   ========================================================= */

function TrainingPage({
  studyDay,
  totalSeconds,
  breathSeconds,
  onFinish,
  onCancel,
}) {
  const [remaining, setRemaining] = useState(totalSeconds)
  const [phase, setPhase] = useState('inhale')
  const [running, setRunning] = useState(true)

  useEffect(() => {
    if (!running) return

    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          setRunning(false)
          return 0
        }

        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (!running) return

    const elapsed = totalSeconds - remaining
    const cyclePosition =
      elapsed % (breathSeconds * 2)

    if (cyclePosition < breathSeconds) {
      setPhase('inhale')
    } else {
      setPhase('exhale')
    }
  }, [
    remaining,
    running,
    totalSeconds,
    breathSeconds,
  ])

  useEffect(() => {
    if (remaining !== 0) return

    const timer = setTimeout(() => {
      onFinish()
    }, 500)

    return () => clearTimeout(timer)
  }, [remaining, onFinish])

  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60

  const timeText =
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}`

  const progress =
    ((totalSeconds - remaining) / totalSeconds) * 100

  const elapsed = totalSeconds - remaining
  const cycle = elapsed % (breathSeconds * 2)

  const phaseNumber =
    phase === 'inhale'
      ? Math.max(1, breathSeconds - cycle)
      : Math.max(1, breathSeconds * 2 - cycle)

  return (
    <main className="app">
      <section className="hero training-page">
        <p className="subtitle">5–5 BREATHING TRAINING</p>

        <div className="day-badge">
          Day {studyDay}
        </div>

        <h1>
          {phase === 'inhale' ? '吸氣' : '吐氣'}
        </h1>

        <div
          className={
            `breathing-ball ${
              phase === 'inhale'
                ? 'inhale'
                : 'exhale'
            }`
          }
        >
          <div className="breathing-number">
            {phaseNumber}
          </div>
        </div>

        <p className="breathing-instruction">
          {phase === 'inhale'
            ? '慢慢吸氣'
            : '慢慢吐氣'}
        </p>

        <div className="remaining-label">
          剩餘時間
        </div>

        <div className="remaining-time">
          {timeText}
        </div>

        <div className="training-progress">
          <div className="progress-header">
            <span>練習進度</span>
            <span>{Math.round(progress)}%</span>
          </div>

          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <button
          className="start-button"
          onClick={onCancel}
        >
          提前結束
        </button>
      </section>
    </main>
  )
}

/* =========================================================
   完成頁
   ========================================================= */

function CompletePage({
  studyDay,
  evaluationDay,
  onHome,
}) {
  const today = new Date()

  const dateText =
    `${today.getFullYear()} / ` +
    `${String(today.getMonth() + 1).padStart(2, '0')} / ` +
    `${String(today.getDate()).padStart(2, '0')}`

  return (
    <main className="app">
      <section className="hero complete-page">
        <p className="subtitle">5–5 BREATHING TRAINING</p>

        <div className="complete-icon">✓</div>

        <h1>今日練習完成</h1>

        <p className="description">
          您已完成
          <br />
          {TRAINING_SECONDS >= 600
            ? '10 分鐘'
            : '測試版 10 秒'}{' '}
          5-5 呼吸訓練
        </p>

        <div className="complete-info">
          <div>
            練習日期
            <strong>{dateText}</strong>
          </div>

          <div>
            研究日
            <strong>Day {studyDay}</strong>
          </div>

          <div>
            今日目標
            <strong>1 次</strong>
          </div>

          <div>
            完成狀態
            <strong>已完成</strong>
          </div>

          {evaluationDay && (
            <div className="evaluation-note">
              ✓ 今日為評估日
              <br />
              已完成訓練後測量流程
            </div>
          )}
        </div>

        <button
          className="start-button"
          onClick={onHome}
        >
          查看訓練紀錄
        </button>
      </section>
    </main>
  )
}

/* =========================================================
   單筆血壓紀錄
   ========================================================= */

function MeasurementRecord({ title, data }) {
  return (
    <div className="measurement-record">
      <div className="measurement-title">
        {title}
      </div>

      {data ? (
        <div className="vital-values">
          <div>
            <span>SBP</span>
            <strong>{data.sbp}</strong>
            <small>mmHg</small>
          </div>

          <div>
            <span>DBP</span>
            <strong>{data.dbp}</strong>
            <small>mmHg</small>
          </div>

          <div>
            <span>HR</span>
            <strong>{data.hr}</strong>
            <small>bpm</small>
          </div>
        </div>
      ) : (
        <div className="no-record">
          尚無資料
        </div>
      )}
    </div>
  )
}

/* =========================================================
   研究者後台
   ========================================================= */

function ResearcherDashboard({
  study,
  records,
  onRefresh,
  onBack,
  onReset,
}) {
  const participantId = study?.participantId || '尚未設定'
  const startDate = study?.startDate || null

  const sortedDates = useMemo(() => {
    return Object.keys(records).sort()
  }, [records])

  const studyRows = useMemo(() => {
    if (!startDate) return []

    return Array.from(
      { length: TOTAL_DAYS },
      (_, index) => {
        const day = index + 1
        const date = new Date(`${startDate}T00:00:00`)
        date.setDate(date.getDate() + index)

        const dateKey = getDateKey(date)
        const record = records[dateKey] || null

        return {
          day,
          dateKey,
          record,
          evaluation: isEvaluationDay(day),
        }
      }
    )
  }, [startDate, records])

  const completedDays = studyRows.filter(
    (row) => row.record?.completed === true
  ).length

  const completionRate =
    TOTAL_DAYS > 0
      ? (completedDays / TOTAL_DAYS) * 100
      : 0

  const trainingRecords = studyRows.filter(
    (row) =>
      row.record?.pre ||
      row.record?.post ||
      row.record?.post30 ||
      row.record?.completed
  )

  const evaluationRows = studyRows.filter(
    (row) => row.evaluation
  )

  const dataCompleteCount = studyRows.filter(
    (row) => {
      if (!row.evaluation) {
        return Boolean(
          row.record?.pre &&
          row.record?.post &&
          row.record?.completed
        )
      }

      return Boolean(
        row.record?.pre &&
        row.record?.post &&
        row.record?.post30 &&
        row.record?.completed
      )
    }
  ).length

  const researchAnalysis = useMemo(
    () => calculateResearchAnalysis(studyRows),
    [studyRows]
  )

  function downloadCSV() {
    const headers = [
      'participantId',
      'date',
      'studyDay',
      'evaluationDay',
      'completed',
      'trainingSeconds',
      'pre_SBP',
      'pre_DBP',
      'pre_HR',
      'pre_time',
      'post_SBP',
      'post_DBP',
      'post_HR',
      'post_time',
      'post30_SBP',
      'post30_DBP',
      'post30_HR',
      'post30_time',
      'SBP_change_pre_to_post',
      'DBP_change_pre_to_post',
      'HR_change_pre_to_post',
      'SBP_MCID_5mmHg',
      'DBP_MCID_5mmHg',
      'completedAt',
    ]

    const rows = studyRows.map((row) => {
      const r = row.record || {}

      return [
        participantId,
        row.dateKey,
        row.day,
        row.evaluation ? 'Y' : 'N',
        r.completed ? 'Y' : 'N',
        r.trainingSeconds ?? '',
        r.pre?.sbp ?? '',
        r.pre?.dbp ?? '',
        r.pre?.hr ?? '',
        r.pre?.time ?? '',
        r.post?.sbp ?? '',
        r.post?.dbp ?? '',
        r.post?.hr ?? '',
        r.post?.time ?? '',
        r.post30?.sbp ?? '',
        r.post30?.dbp ?? '',
        r.post30?.hr ?? '',
        r.post30?.time ?? '',
        r.pre && r.post ? getChange(r.pre.sbp, r.post.sbp) : '',
        r.pre && r.post ? getChange(r.pre.dbp, r.post.dbp) : '',
        r.pre && r.post ? getChange(r.pre.hr, r.post.hr) : '',
        r.pre && r.post ? (getChange(r.pre.sbp, r.post.sbp) <= -MCID_SBP ? 'Y' : 'N') : '',
        r.pre && r.post ? (getChange(r.pre.dbp, r.post.dbp) <= -MCID_DBP ? 'Y' : 'N') : '',
        r.completedAt ?? '',
      ]
    })

    const escapeCSV = (value) => {
      const text = String(value ?? '')
      if (
        text.includes(',') ||
        text.includes('"') ||
        text.includes('\n')
      ) {
        return `"${text.replaceAll('"', '""')}"`
      }
      return text
    }

    const csv = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row) =>
        row.map(escapeCSV).join(',')
      ),
    ].join('\n')

    const blob = new Blob(
      ['\ufeff' + csv],
      { type: 'text/csv;charset=utf-8;' }
    )

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download =
      `${participantId}_breathing_study_28days.csv`

    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <main className="app">
      <section className="hero researcher-page">
        <p className="subtitle">
          5–5 BREATHING TRAINING
        </p>

        <div className="researcher-header">
          <div>
            <span className="researcher-label">
              RESEARCHER DASHBOARD
            </span>

            <h1>研究者後台</h1>
          </div>

          <button
            className="refresh-button"
            onClick={onRefresh}
          >
            ↻ 更新資料
          </button>
        </div>

        {/* 研究基本資料 */}
        <div className="researcher-card participant-card">
          <div className="researcher-card-title">
            受試者基本資料
          </div>

          <div className="participant-summary">
            <div>
              <span>研究編號</span>
              <strong>{participantId}</strong>
            </div>

            <div>
              <span>研究開始日</span>
              <strong>
                {startDate
                  ? formatDisplayDate(startDate)
                  : '尚未開始'}
              </strong>
            </div>

            <div>
              <span>研究期間</span>
              <strong>28 天</strong>
            </div>

            <div>
              <span>評估日</span>
              <strong>Day 1 / 14 / 28</strong>
            </div>
          </div>
        </div>

        {/* KPI */}
        <div className="dashboard-kpi-grid">
          <div className="kpi-card">
            <span>完成天數</span>
            <strong>
              {completedDays}
              <small>/ 28</small>
            </strong>
          </div>

          <div className="kpi-card">
            <span>28 天完成率</span>
            <strong>
              {completionRate.toFixed(1)}%
            </strong>
          </div>

          <div className="kpi-card">
            <span>已建立紀錄</span>
            <strong>
              {trainingRecords.length}
              <small>天</small>
            </strong>
          </div>

          <div className="kpi-card">
            <span>資料完整</span>
            <strong>
              {dataCompleteCount}
              <small>/ 28</small>
            </strong>
          </div>
        </div>

        {/* 評估日摘要 */}
        <div className="researcher-card">
          <div className="researcher-card-title">
            評估日資料摘要
          </div>

          <div className="evaluation-grid">
            {evaluationRows.map((row) => (
              <EvaluationSummary
                key={row.day}
                row={row}
              />
            ))}
          </div>
        </div>

        {/* 統計分析 */}
        <div className="researcher-card">
          <div className="researcher-card-title">
            研究結果分析
          </div>

          <p style={{ marginTop: 0 }}>
            P 值、Effect Size 與 MCID 分開呈現：P 值需等正式 GEE
            分析後填入；目前頁面先提供受試者評估日的變化與探索性效果量。
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '12px',
              marginTop: '16px',
            }}
          >
            <StatAnalysisBox
              title="SBP"
              analysis={researchAnalysis.sbp}
              unit="mmHg"
            />

            <StatAnalysisBox
              title="DBP"
              analysis={researchAnalysis.dbp}
              unit="mmHg"
            />

            <StatAnalysisBox
              title="HR"
              analysis={researchAnalysis.hr}
              unit="bpm"
              isHeartRate
            />
          </div>

          <div
            style={{
              marginTop: '16px',
              padding: '14px 16px',
              borderRadius: '14px',
              background: 'rgba(255,255,255,0.38)',
              border: '1px solid rgba(255,255,255,0.65)',
              lineHeight: 1.7,
            }}
          >
            <strong>正式統計分析提醒</strong>
            <div>
              P 值：<strong>待正式 GEE 分析</strong>
            </div>
            <div>
              正式 Effect Size：<strong>待正式統計分析</strong>
            </div>
            <div>
              目前顯示的 Effect Size 為探索性 paired Cohen's dz，
              不取代正式 GEE 結果。
            </div>
            <div>
              MCID：SBP / DBP 目前以下降 ≥ {MCID_SBP} mmHg 作為達標門檻。
            </div>
          </div>
        </div>

        {/* 28 天資料表 */}
        <div className="researcher-card table-card">
          <div className="table-header-row">
            <div>
              <div className="researcher-card-title">
                28 天研究資料
              </div>

              <p>
                每日：訓練前、訓練後立即；
                Day 1、14、28 另有 30 分鐘後測量。
              </p>
            </div>

            <button
              className="export-button"
              onClick={downloadCSV}
            >
              匯出 CSV
            </button>
          </div>

          <div className="table-scroll">
            <table className="research-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>日期</th>
                  <th>訓練</th>
                  <th>前測</th>
                  <th>立即後測</th>
                  <th>30 分鐘後</th>
                  <th>狀態</th>
                </tr>
              </thead>

              <tbody>
                {studyRows.map((row) => (
                  <ResearchTableRow
                    key={row.day}
                    row={row}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 原始資料鍵值提醒 */}
        <div className="researcher-note">
          <strong>目前資料儲存方式</strong>
          <p>
            本版本沿用目前 App 的 localStorage。
            研究者後台讀取的是此瀏覽器中的研究資料，
            不會自動同步其他手機或電腦。
          </p>
          <p>
            正式收案前若要讓研究者集中查看 P001、
            P002、P003……等不同受試者，
            下一階段再將相同資料結構接到 Firebase
            即可。
          </p>
        </div>

        <div className="researcher-actions">
          <button
            className="start-button"
            onClick={onBack}
          >
            返回受試者端
          </button>

          <button
            className="secondary-button danger-button"
            onClick={onReset}
          >
            清除測試資料
          </button>
        </div>

        {sortedDates.length > 0 && (
          <div className="storage-hint">
            本機目前共有 {sortedDates.length} 個日期紀錄
          </div>
        )}
      </section>
    </main>
  )
}

/* =========================================================
   統計分析卡片
   ========================================================= */

function StatAnalysisBox({ title, analysis, unit, isHeartRate = false }) {
  const meanChangeText =
    analysis.meanChange === null
      ? '資料不足'
      : `${analysis.meanChange > 0 ? '+' : ''}${formatNumber(analysis.meanChange)} ${unit}`

  const mcidText = isHeartRate
    ? '不適用'
    : analysis.n === 0
      ? '資料不足'
      : analysis.mcidCount > 0
        ? `✓ ${analysis.mcidCount}/${analysis.n} 次達 MCID`
        : '未達 MCID'

  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '14px',
        background: 'rgba(255,255,255,0.35)',
        border: '1px solid rgba(255,255,255,0.65)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '10px' }}>
        {title}
      </div>

      <div style={{ marginBottom: '6px' }}>
        <span>平均變化</span>
        <strong style={{ display: 'block', fontSize: '1.15em' }}>
          {meanChangeText}
        </strong>
      </div>

      <div style={{ marginBottom: '6px' }}>
        <span>探索性 Effect Size</span>
        <strong style={{ display: 'block' }}>
          {analysis.effectSize === null
            ? '資料不足'
            : formatNumber(analysis.effectSize, 2)}
        </strong>
      </div>

      <div style={{ marginBottom: '6px' }}>
        <span>MCID</span>
        <strong style={{ display: 'block' }}>
          {isHeartRate ? '不適用' : `${analysis.mcid} mmHg`}
        </strong>
      </div>

      <div style={{ marginBottom: '6px' }}>
        <span>MCID 判定</span>
        <strong style={{ display: 'block' }}>
          {mcidText}
        </strong>
      </div>

      <div style={{ fontSize: '0.85em', opacity: 0.75 }}>
        可用評估日：{analysis.n} 次
      </div>
    </div>
  )
}

/* =========================================================
   評估日摘要
   ========================================================= */

function EvaluationSummary({ row }) {
  const record = row.record

  const complete =
    Boolean(
      record?.pre &&
      record?.post &&
      record?.post30 &&
      record?.completed
    )

  return (
    <div className="evaluation-summary">
      <div className="evaluation-summary-top">
        <div>
          <span>評估日</span>
          <strong>Day {row.day}</strong>
        </div>

        <span
          className={
            complete
              ? 'status-pill complete'
              : 'status-pill incomplete'
          }
        >
          {complete ? '資料完整' : '資料未完整'}
        </span>
      </div>

      <div className="evaluation-vitals">
        <MiniMeasurement
          title="訓練前"
          data={record?.pre}
        />

        <MiniMeasurement
          title="立即後"
          data={record?.post}
        />

        <MiniMeasurement
          title="30 分鐘後"
          data={record?.post30}
        />
      </div>
    </div>
  )
}

function MiniMeasurement({ title, data }) {
  return (
    <div className="mini-measurement">
      <span>{title}</span>

      {data ? (
        <strong>
          {data.sbp}/{data.dbp}
          <small> HR {data.hr}</small>
        </strong>
      ) : (
        <strong className="missing-text">
          尚無資料
        </strong>
      )}
    </div>
  )
}

/* =========================================================
   研究資料表格列
   ========================================================= */

function ResearchTableRow({ row }) {
  const record = row.record

  const completed =
    record?.completed === true

  const hasPre = Boolean(record?.pre)
  const hasPost = Boolean(record?.post)
  const hasPost30 = Boolean(record?.post30)

  const complete =
    row.evaluation
      ? Boolean(
          hasPre &&
          hasPost &&
          hasPost30 &&
          completed
        )
      : Boolean(
          hasPre &&
          hasPost &&
          completed
        )

  return (
    <tr
      className={
        row.evaluation
          ? 'evaluation-row'
          : ''
      }
    >
      <td>
        <strong>Day {row.day}</strong>

        {row.evaluation && (
          <span className="evaluation-tag">
            評估
          </span>
        )}
      </td>

      <td>{formatShortDate(row.dateKey)}</td>

      <td>
        {record?.trainingSeconds
          ? `${record.trainingSeconds} 秒`
          : '—'}
      </td>

      <td>
        <TableVital data={record?.pre} />
      </td>

      <td>
        <TableVital data={record?.post} />
      </td>

      <td>
        {row.evaluation ? (
          <TableVital data={record?.post30} />
        ) : (
          <span className="not-required">—</span>
        )}
      </td>

      <td>
        <span
          className={
            complete
              ? 'status-pill complete'
              : completed
                ? 'status-pill partial'
                : 'status-pill incomplete'
          }
        >
          {complete
            ? '完整'
            : completed
              ? '部分'
              : '未完成'}
        </span>
      </td>
    </tr>
  )
}

function TableVital({ data }) {
  if (!data) {
    return (
      <span className="missing-text">
        —
      </span>
    )
  }

  return (
    <span className="table-vital">
      {data.sbp}/{data.dbp}
      <small> HR {data.hr}</small>
    </span>
  )
}

export default App

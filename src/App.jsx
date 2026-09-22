import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { db, authReady } from './firebase'
import {
  doc,
  setDoc,
  serverTimestamp,
  collection,
  getDocs,
} from 'firebase/firestore'

async function loadAllParticipants() {
  try {
    await authReady

    // ① 先取得所有受試者
    const snapshot = await getDocs(
      collection(db, 'participants')
    )

    // ② 每一位受試者再讀取自己的 records
    const participants = await Promise.all(
      snapshot.docs.map(async (participantDoc) => {
        const participantId = participantDoc.id
        const participantData = participantDoc.data()

        // 讀取：
        // participants / P001 / records
        const recordsSnapshot = await getDocs(
          collection(
            db,
            'participants',
            participantId,
            'records'
          )
        )

        // 將每天的 records 整理成：
        // {
        //   "2026-09-19": {...},
        //   "2026-09-20": {...}
        // }
        const records = {}

        recordsSnapshot.forEach((recordDoc) => {
          records[recordDoc.id] = {
            ...recordDoc.data(),
          }
        })

        return {
          id: participantId,
          ...participantData,
          records,
        }
      })
    )

    console.log(
      'Firebase：目前共有',
      participants.length,
      '位受試者'
    )

    console.log(
      'Firebase：完整受試者資料',
      participants
    )

    // 轉成研究者後台目前使用的格式
    const participantMap = {}

    participants.forEach((participant) => {
      participantMap[participant.id] = {
        ...participant,
        records: participant.records || {},
      }
    })

    console.log(
      '研究者後台：完整受試者資料',
      participantMap
    )

    return participantMap
  } catch (error) {
    console.error(
      'Firebase 讀取受試者資料失敗：',
      error
    )

    return {}
  }
}

async function loadParticipantRecords(participantId) {
  try {
    await authReady

    const snapshot = await getDocs(
      collection(
        db,
        'participants',
        participantId,
        'records'
      )
    )

    const records = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }))

    console.log(
      `Firebase：${participantId} 共有`,
      records.length,
      '筆紀錄',
      records
    )

    return records
  } catch (error) {
    console.error(
      `Firebase：讀取 ${participantId} records 失敗`,
      error
    )

    return []
  }
}

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

  const [allParticipants, setAllParticipants] = useState([])
  const [allParticipantRecords, setAllParticipantRecords] = useState({})

const [page, setPage] = useState(() => {
  const path = window.location.pathname

  // /researcher → 研究者登入頁
  if (path === '/researcher') {
    return 'researcher-login'
  }

  // 一般首頁 → 受試者端
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

 useEffect(() => {
  async function fetchParticipants() {
    const participants = await loadAllParticipants()

    setAllParticipants(participants)

    console.log(
      '研究者後台：目前 Firebase 受試者數量',
      participants.length
    )

    console.log(
      '研究者後台：受試者清單',
      participants
    )

    const recordsByParticipant = {}

    for (const participant of participants) {
      const records = await loadParticipantRecords(
        participant.id
      )

      recordsByParticipant[participant.id] = records
    }

    setAllParticipantRecords(recordsByParticipant)

    console.log(
      '研究者後台：所有受試者紀錄',
      recordsByParticipant
    )
  }

  fetchParticipants()
}, [])

  async function refreshLocalData() {
  try {
    const participants = await loadAllParticipants()

    setAllParticipants(participants)

    const recordsByParticipant = {}

    for (const participant of Object.values(participants)) {
      recordsByParticipant[participant.id] =
        participant.records || {}
    }

    setAllParticipantRecords(recordsByParticipant)

    console.log(
      '研究者後台：Firebase 資料已更新',
      participants
    )
  } catch (error) {
    console.error(
      '研究者後台：更新 Firebase 資料失敗',
      error
    )
  }
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

  async function startStudy() {
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

  try {
    // 等待 Firebase 匿名登入完成
    await authReady

    // 將研究基本資料寫入 Firestore
    await setDoc(
      doc(db, 'participants', id),
      {
        participantId: id,
        startDate: newStudy.startDate,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )

    console.log(
      `Firestore：${id} 研究資料建立成功`
    )

    // 暫時保留 localStorage
    // 避免一次修改太多功能
    localStorage.setItem(
      STORAGE_KEYS.study,
      JSON.stringify(newStudy)
    )

    setStudy(newStudy)
    setParticipantId(id)
    setPage('pre')
  } catch (error) {
    console.error(
      'Firestore 儲存研究資料失敗:',
      error
    )

    alert(
      '研究資料尚未成功連線到雲端，請確認 Firebase 連線後再試一次。'
    )
  }
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

  async function savePreMeasurement(sbp, dbp, hr) {
  const time = new Date().toISOString()

  // 先照原本方式儲存在本機
  updateTodayRecord({
    date: todayKey,
    participantId,
    day: studyDay,
    pre: {
      sbp,
      dbp,
      hr,
      time,
    },
  })

  try {
    // 等待 Firebase 匿名登入完成
    await authReady

    // 寫入 Firestore
    await setDoc(
      doc(
        db,
        'participants',
        participantId,
        'records',
        todayKey
      ),
      {
        participantId,
        date: todayKey,
        day: studyDay,
        pre: {
          sbp,
          dbp,
          hr,
          time,
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )

    console.log(
      `Firestore：${participantId} Day ${studyDay} 前測儲存成功`
    )
  } catch (error) {
    console.error(
      'Firestore 儲存前測失敗:',
      error
    )

    alert(
      '前測資料已暫存在本機，但尚未成功同步到雲端。'
    )
  }
}

 async function savePostMeasurement(sbp, dbp, hr) {
  const time = new Date().toISOString()

  // 先保留原本的本機儲存
  updateTodayRecord({
    post: {
      sbp,
      dbp,
      hr,
      time,
    },
  })

  try {
    // 等待 Firebase 匿名登入完成
    await authReady

    // 將訓練後立即測量寫入 Firestore
    await setDoc(
      doc(
        db,
        'participants',
        participantId,
        'records',
        todayKey
      ),
      {
        post: {
          sbp,
          dbp,
          hr,
          time,
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )

    console.log(
      `Firestore：${participantId} Day ${studyDay} 訓練後立即測量儲存成功`
    )
  } catch (error) {
    console.error(
      'Firestore 儲存訓練後立即測量失敗:',
      error
    )

    alert(
      '訓練後立即測量已儲存在本機，但尚未成功同步到雲端。'
    )
  }
}

  async function savePost30Measurement(sbp, dbp, hr) {
  const time = new Date().toISOString()

  // 先保留原本的本機儲存
  updateTodayRecord({
    post30: {
      sbp,
      dbp,
      hr,
      time,
    },
  })

  try {
    // 等待 Firebase 匿名登入完成
    await authReady

    // 將 30 分鐘後測量資料寫入 Firestore
    await setDoc(
      doc(
        db,
        'participants',
        participantId,
        'records',
        todayKey
      ),
      {
        post30: {
          sbp,
          dbp,
          hr,
          time,
        },
      },
      { merge: true }
    )

    console.log(
      `Firestore：${participantId} Day ${studyDay} 30 分鐘後測量儲存成功`
    )
  } catch (error) {
    console.error(
      'Firestore 儲存 30 分鐘後測量資料失敗：',
      error
    )

    alert(
      '30 分鐘後測量已保存在本機，但尚未成功同步到雲端。'
    )
  }
}

 async function completeTraining() {
  const completedAt = new Date().toISOString()

  // 先照原本方式儲存在本機
  updateTodayRecord({
    completed: true,
    completedAt,
    trainingSeconds: TRAINING_SECONDS,
  })

  try {
    // 等待 Firebase 匿名登入完成
    await authReady

    // 將訓練完成資料寫入 Firestore
    await setDoc(
      doc(
        db,
        'participants',
        participantId,
        'records',
        todayKey
      ),
      {
        completed: true,
        completedAt,
        trainingSeconds: TRAINING_SECONDS,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )

    console.log(
      `Firestore：${participantId} Day ${studyDay} 訓練完成儲存成功`
    )
  } catch (error) {
    console.error(
      'Firestore 儲存訓練完成資料失敗:',
      error
    )

    alert(
      '訓練完成資料已暫存在本機，但尚未成功同步到雲端。'
    )
  }
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
  window.location.assign('/researcher')
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
  allParticipants={allParticipants}
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
        onComplete={async (sbp, dbp, hr) => {
  await savePreMeasurement(sbp, dbp, hr)
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
       onFinish={async () => {
  await completeTraining()
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
       onComplete={async (sbp, dbp, hr) => {
  await savePostMeasurement(sbp, dbp, hr)

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
        onComplete={async (sbp, dbp, hr) => {
  await savePost30Measurement(sbp, dbp, hr)
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

/* =========================================================
   呼吸訓練頁
   5 秒吸氣 + 5 秒吐氣
   加入：
   1. 吸氣 / 吐氣不同深淺藍色
   2. 中文口述提示
   3. 吸吐轉換提示音
   ========================================================= */

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

  // 一開始先不要自動跑
  const [running, setRunning] = useState(false)

  const [started, setStarted] = useState(false)

  const audioContextRef = useRef(null)

  const previousPhaseRef = useRef(null)

  /* -------------------------------------------------------
     建立 AudioContext
  ------------------------------------------------------- */

  function getAudioContext() {
    if (typeof window === 'undefined') {
      return null
    }

    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext

    if (!AudioContextClass) {
      return null
    }

    if (!audioContextRef.current) {
      audioContextRef.current =
        new AudioContextClass()
    }

    return audioContextRef.current
  }

  /* -------------------------------------------------------
     啟動 AudioContext
     必須放在使用者按鈕事件裡
  ------------------------------------------------------- */

  async function unlockAudio() {
    const audioContext =
      getAudioContext()

    if (!audioContext) {
      return
    }

    try {
      if (
        audioContext.state === 'suspended'
      ) {
        await audioContext.resume()
      }
    } catch (error) {
      console.log(
        'AudioContext 啟動失敗：',
        error
      )
    }
  }

  /* -------------------------------------------------------
     播放吸氣 / 吐氣提示音
  ------------------------------------------------------- */

  function playTransitionSound(
    nextPhase
  ) {
    const audioContext =
      getAudioContext()

    if (!audioContext) {
      return
    }

    if (
      audioContext.state === 'suspended'
    ) {
      return
    }

    const oscillator =
      audioContext.createOscillator()

    const gainNode =
      audioContext.createGain()

    oscillator.connect(gainNode)

    gainNode.connect(
      audioContext.destination
    )

    // 吸氣高音、吐氣低音
    const frequency =
      nextPhase === 'inhale'
        ? 720
        : 480

    oscillator.type = 'sine'

    oscillator.frequency.setValueAtTime(
      frequency,
      audioContext.currentTime
    )

    gainNode.gain.setValueAtTime(
      0.0001,
      audioContext.currentTime
    )

    gainNode.gain.exponentialRampToValueAtTime(
      0.12,
      audioContext.currentTime + 0.03
    )

    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + 0.35
    )

    oscillator.start(
      audioContext.currentTime
    )

    oscillator.stop(
      audioContext.currentTime + 0.4
    )
  }

  /* -------------------------------------------------------
     中文口述
  ------------------------------------------------------- */

  function speakPhase(
    nextPhase
  ) {
    if (
      typeof window === 'undefined'
    ) {
      return
    }

    if (
      !('speechSynthesis' in window)
    ) {
      console.log(
        '此瀏覽器不支援語音合成'
      )

      return
    }

    const speech =
      window.speechSynthesis

    speech.cancel()

    const text =
      nextPhase === 'inhale'
        ? '吸氣'
        : '吐氣'

    const utterance =
      new SpeechSynthesisUtterance(
        text
      )

    utterance.lang = 'zh-TW'

    utterance.rate = 0.75

    utterance.pitch = 1

    utterance.volume = 1

    const voices =
      speech.getVoices()

    const chineseVoice =
      voices.find(
        (voice) =>
          voice.lang === 'zh-TW'
      ) ||
      voices.find(
        (voice) =>
          voice.lang === 'zh-TW'
      ) ||
      voices.find(
        (voice) =>
          voice.lang.startsWith('zh')
      )

    if (chineseVoice) {
      utterance.voice =
        chineseVoice
    }

    utterance.onerror = (
      event
    ) => {
      console.log(
        '語音播放錯誤：',
        event.error
      )
    }

    speech.speak(
      utterance
    )
  }

  /* -------------------------------------------------------
     開始訓練
     這裡是最重要的：
     使用者按下按鈕後才啟動音效與語音
  ------------------------------------------------------- */

  async function handleStart() {
    await unlockAudio()

    setStarted(true)

    setRunning(true)

    previousPhaseRef.current =
      'inhale'

    // 第一次吸氣
    playTransitionSound(
      'inhale'
    )

    speakPhase(
      'inhale'
    )
  }

  /* -------------------------------------------------------
     倒數
  ------------------------------------------------------- */

  useEffect(() => {
    if (!running) {
      return
    }

    const timer =
      setInterval(() => {
        setRemaining(
          (prev) => {
            if (prev <= 1) {
              clearInterval(
                timer
              )

              setRunning(false)

              return 0
            }

            return prev - 1
          }
        )
      }, 1000)

    return () =>
      clearInterval(timer)
  }, [running])

  /* -------------------------------------------------------
     判斷吸氣 / 吐氣
  ------------------------------------------------------- */

  useEffect(() => {
    if (!running) {
      return
    }

    const elapsed =
      totalSeconds -
      remaining

    const cyclePosition =
      elapsed %
      (breathSeconds * 2)

    const nextPhase =
      cyclePosition <
      breathSeconds
        ? 'inhale'
        : 'exhale'

    setPhase(
      nextPhase
    )

    /* -----------------------------------------------------
       只有真的從吸氣變吐氣，
       或從吐氣變吸氣時才播放
    ----------------------------------------------------- */

    if (
      previousPhaseRef.current !==
      null &&
      previousPhaseRef.current !==
      nextPhase
    ) {
      previousPhaseRef.current =
        nextPhase

      playTransitionSound(
        nextPhase
      )

      speakPhase(
        nextPhase
      )
    }
  }, [
    remaining,
    running,
    totalSeconds,
    breathSeconds,
  ])

  /* -------------------------------------------------------
     訓練完成
  ------------------------------------------------------- */

  useEffect(() => {
    if (
      remaining !== 0
    ) {
      return
    }

    if (
      typeof window !==
      'undefined' &&
      'speechSynthesis' in
        window
    ) {
      window.speechSynthesis.cancel()
    }

    const timer =
      setTimeout(() => {
        onFinish()
      }, 500)

    return () =>
      clearTimeout(timer)
  }, [
    remaining,
    onFinish,
  ])

  /* -------------------------------------------------------
     載入中文語音
  ------------------------------------------------------- */

  useEffect(() => {
    if (
      typeof window ===
      'undefined'
    ) {
      return
    }

    if (
      !('speechSynthesis' in
        window)
    ) {
      return
    }

    const speech =
      window.speechSynthesis

    // 先讀一次
    speech.getVoices()

    // Chrome 可能需要等待 voiceschanged
    const handleVoicesChanged =
      () => {
        speech.getVoices()
      }

    speech.addEventListener(
      'voiceschanged',
      handleVoicesChanged
    )

    return () => {
      speech.removeEventListener(
        'voiceschanged',
        handleVoicesChanged
      )
    }
  }, [])

  /* -------------------------------------------------------
     離開頁面時清理
  ------------------------------------------------------- */

  useEffect(() => {
    return () => {
      if (
        typeof window !==
          'undefined' &&
        'speechSynthesis' in
          window
      ) {
        window.speechSynthesis.cancel()
      }

      if (
        audioContextRef.current
      ) {
        audioContextRef.current.close()

        audioContextRef.current =
          null
      }
    }
  }, [])

  /* -------------------------------------------------------
     顯示時間
  ------------------------------------------------------- */

  const minutes =
    Math.floor(
      remaining / 60
    )

  const seconds =
    remaining % 60

  const timeText =
    `${String(minutes).padStart(
      2,
      '0'
    )}:` +
    `${String(seconds).padStart(
      2,
      '0'
    )}`

  const progress =
    (
      (totalSeconds -
        remaining) /
      totalSeconds
    ) * 100

  const elapsed =
    totalSeconds -
    remaining

  const cycle =
    elapsed %
    (breathSeconds * 2)

  const phaseNumber =
    phase === 'inhale'
      ? Math.max(
          1,
          breathSeconds -
            cycle
        )
      : Math.max(
          1,
          breathSeconds * 2 -
            cycle
        )

  const phaseText =
    phase === 'inhale'
      ? '吸氣'
      : '吐氣'

  const instructionText =
    phase === 'inhale'
      ? '慢慢吸氣'
      : '慢慢吐氣'

  return (
    <main className="app">
      <section className="hero training-page">

        <p className="subtitle">
          5–5 BREATHING TRAINING
        </p>

        <div className="day-badge">
          Day {studyDay}
        </div>

        <h1
          className={
            phase === 'inhale'
              ? 'phase-title inhale'
              : 'phase-title exhale'
          }
        >
          {started
            ? phaseText
            : '準備開始'}
        </h1>

        {!started ? (
          <>
            <div className="breathing-ball pre-start">
              <div className="breathing-number">
                5
              </div>
            </div>

            <p className="breathing-instruction inhale">
              按下開始後，會有語音提示
            </p>

            <div className="audio-guide">
              <span>🔊</span>
              <span>
                開始後會播放「吸氣」語音
              </span>
            </div>

            <button
              className="start-button"
              onClick={
                handleStart
              }
            >
              開始訓練
            </button>

            <button
              className="secondary-button"
              onClick={onCancel}
            >
              返回
            </button>
          </>
        ) : (
          <>
            <div
              className={
                `breathing-ball ${
                  phase === 'inhale'
                    ? 'inhale'
                    : 'exhale'
                }`
              }
              aria-label={
                phaseText
              }
            >
              <div className="breathing-number">
                {phaseNumber}
              </div>
            </div>

            <p
              className={
                phase === 'inhale'
                  ? 'breathing-instruction inhale'
                  : 'breathing-instruction exhale'
              }
            >
              {instructionText}
            </p>

            <div className="audio-guide">
              <span>🔊</span>
              <span>
                語音提示：吸氣／吐氣
              </span>
              <span>・</span>
              <span>
                轉換時有提示音
              </span>
            </div>

            <div className="remaining-label">
              剩餘時間
            </div>

            <div className="remaining-time">
              {timeText}
            </div>

            <div className="training-progress">

              <div className="progress-header">
                <span>
                  練習進度
                </span>

                <span>
                  {Math.round(
                    progress
                  )}
                  %
                </span>
              </div>

              <div className="progress-bar">

                <div
                  className="progress-fill"
                  style={{
                    width:
                      `${progress}%`,
                  }}
                />

              </div>

            </div>

            <button
              className="start-button"
              onClick={onCancel}
            >
              提前結束
            </button>
          </>
        )}

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

function formatParticipantId(id) {
  const value = String(id ?? '')

  if (value.toUpperCase().startsWith('P')) {
    return value.toUpperCase()
  }

  if (/^\d+$/.test(value)) {
    return `P${value.padStart(3, '0')}`
  }

  return value
}

   function ResearcherDashboard({
  study,
  records,
  allParticipants,
  onRefresh,
  onBack,
  onReset,
}) {
  const defaultParticipantId =
  study?.participantId || '尚未設定'

  const participantIds = Object.keys(allParticipants || {}).sort(
  (a, b) =>
    String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
)

const selectedParticipantId =
  participantIds.includes(defaultParticipantId)
    ? defaultParticipantId
    : participantIds[0] || defaultParticipantId
  
    const [selectedParticipant, setSelectedParticipant] =
  useState(selectedParticipantId)

  const [participantMenuOpen, setParticipantMenuOpen] = useState(false)

  const selectedParticipantRecords = useMemo(() => {
  const data = allParticipants?.[selectedParticipant]

  if (!data) {
    return []
  }

  // 情況 1：Firebase 直接回傳每日紀錄陣列
  if (Array.isArray(data)) {
    return data
  }

  // 情況 2：Firebase 回傳
  // {
  //   participantId: "P001",
  //   records: [...]
  // }
  if (Array.isArray(data.records)) {
    return data.records
  }

  // 情況 3：Firebase 回傳
  // {
  //   participantId: "P001",
  //   dailyRecords: [...]
  // }
  if (Array.isArray(data.dailyRecords)) {
    return data.dailyRecords
  }

  // 情況 4：records 本身是用日期當 key 的物件
  if (
    data.records &&
    typeof data.records === 'object'
  ) {
    return Object.values(data.records)
  }

  // 情況 5：整個 data 本身就是
  // { "2026-09-19": {...}, "2026-09-20": {...} }
  if (typeof data === 'object') {
    const values = Object.values(data)

    return values.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        item.date
    )
  }

  return []
}, [allParticipants, selectedParticipant])

const selectedRecords = useMemo(() => {
  const result = {}

  selectedParticipantRecords.forEach((record) => {
    if (record?.date) {
      result[record.date] = record
    }
  })

  return result
}, [selectedParticipantRecords])

  const startDate =
  selectedParticipantRecords[0]?.date ||
  study?.startDate ||
  null

  const sortedDates = useMemo(() => {
  return Object.keys(selectedRecords).sort()
}, [selectedRecords])

  const studyRows = useMemo(() => {
    if (!startDate) return []

    return Array.from(
      { length: TOTAL_DAYS },
      (_, index) => {
        const day = index + 1
        const date = new Date(`${startDate}T00:00:00`)
        date.setDate(date.getDate() + index)

        const dateKey = getDateKey(date)
        const record = selectedRecords[dateKey]|| null

        return {
          day,
          dateKey,
          record,
          evaluation: isEvaluationDay(day),
        }
      }
    )
  }, [startDate, selectedRecords])

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

    const allParticipantAnalysis = useMemo(() => {
    const participants = Object.values(allParticipants || {})

    const result = {
      1: {
        sbp: { immediate: [], post30: [] },
        dbp: { immediate: [], post30: [] },
        hr: { immediate: [], post30: [] },
      },
      14: {
        sbp: { immediate: [], post30: [] },
        dbp: { immediate: [], post30: [] },
        hr: { immediate: [], post30: [] },
      },
      28: {
        sbp: { immediate: [], post30: [] },
        dbp: { immediate: [], post30: [] },
        hr: { immediate: [], post30: [] },
      },
    }

    participants.forEach((participant) => {
      const participantRecords = participant?.records || {}

      Object.values(participantRecords).forEach((record) => {
        const day = record?.day

        if (![1, 14, 28].includes(day)) {
          return
        }

        const pre = record?.pre
        const post = record?.post
        const post30 = record?.post30

        if (!result[day]) {
          return
        }

        // 立即後測：Post - Pre
        if (pre && post) {
          const sbpImmediate = getChange(
            pre.sbp,
            post.sbp
          )

          const dbpImmediate = getChange(
            pre.dbp,
            post.dbp
          )

          const hrImmediate = getChange(
            pre.hr,
            post.hr
          )

          if (sbpImmediate !== null) {
            result[day].sbp.immediate.push(sbpImmediate)
          }

          if (dbpImmediate !== null) {
            result[day].dbp.immediate.push(dbpImmediate)
          }

          if (hrImmediate !== null) {
            result[day].hr.immediate.push(hrImmediate)
          }
        }

        // 30 分鐘後：Post30 - Pre
        if (pre && post30) {
          const sbpPost30 = getChange(
            pre.sbp,
            post30.sbp
          )

          const dbpPost30 = getChange(
            pre.dbp,
            post30.dbp
          )

          const hrPost30 = getChange(
            pre.hr,
            post30.hr
          )

          if (sbpPost30 !== null) {
            result[day].sbp.post30.push(sbpPost30)
          }

          if (dbpPost30 !== null) {
            result[day].dbp.post30.push(dbpPost30)
          }

          if (hrPost30 !== null) {
            result[day].hr.post30.push(hrPost30)
          }
        }
      })
    })

    return result
  }, [allParticipants])

    function getAverageText(values, unit) {
    if (!values.length) {
      return '資料不足'
    }

    const average = mean(values)

    return `${average > 0 ? '+' : ''}${formatNumber(
      average
    )} ${unit}`
  }

  function getMcidText(values, mcid) {
    if (!values.length) {
      return '資料不足'
    }

    const count = values.filter(
      (value) => value <= -mcid
    ).length

    return `${count}/${values.length}`
  }

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
{/* 全部受試者總覽 */}
<div
  style={{
    marginTop: '16px',
    padding: '18px',
        width: '100%',
    boxSizing: 'border-box',
    borderRadius: '16px',
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(255,255,255,0.95)',
  }}
>
  <div
    style={{
      fontSize: '21px',
      fontWeight: '700',
      color: '#155e75',
      marginBottom: '14px',
    }}
  >
    全部受試者總覽
  </div>

  {participantIds.length === 0 ? (
    <div
      style={{
        padding: '24px',
        textAlign: 'center',
        color: '#64748b',
        fontSize: '18px',
      }}
    >
      目前尚無受試者資料
    </div>
  ) : (
    <div
      style={{
        width: '100%',
        overflowX: 'auto',
      }}
    >
      <table
        style={{
          width: '100%',
          minWidth: '900px',
          borderCollapse: 'separate',
          borderSpacing: 0,
          background: '#ffffff',
          borderRadius: '12px',
          overflow: 'hidden',
        }}
      >
        <thead>
          <tr
            style={{
              background: '#e0f2fe',
              color: '#155e75',
            }}
          >
            <th
              style={{
                padding: '14px 10px',
                textAlign: 'left',
                fontSize: '16px',
              }}
            >
              受試者
            </th>

            <th
              style={{
                padding: '14px 10px',
                textAlign: 'center',
                fontSize: '16px',
              }}
            >
              完成率
            </th>

            <th
              style={{
                padding: '14px 10px',
                textAlign: 'center',
                fontSize: '16px',
              }}
            >
              Day 1
            </th>

            <th
              style={{
                padding: '14px 10px',
                textAlign: 'center',
                fontSize: '16px',
              }}
            >
              Day 14
            </th>

            <th
              style={{
                padding: '14px 10px',
                textAlign: 'center',
                fontSize: '16px',
              }}
            >
              Day 28
            </th>
          </tr>
        </thead>

        <tbody>
          {Array.from(
            new Map(
              participantIds.map((id) => [
                formatParticipantId(id),
                id,
              ])
            ).values()
          ).map((id) => {
            const data = allParticipants?.[id]

            let participantRecords = []

            if (Array.isArray(data)) {
              participantRecords = data
            } else if (Array.isArray(data?.records)) {
              participantRecords = data.records
            } else if (
              Array.isArray(data?.dailyRecords)
            ) {
              participantRecords = data.dailyRecords
            } else if (
              data?.records &&
              typeof data.records === 'object'
            ) {
              participantRecords = Object.values(
                data.records
              )
            } else if (
              data &&
              typeof data === 'object'
            ) {
              participantRecords =
                Object.values(data).filter(
                  (item) =>
                    item &&
                    typeof item === 'object' &&
                    item.date
                )
            }

            const validRecords =
              participantRecords
                .filter(
                  (record) => record?.date
                )
                .sort((a, b) =>
                  String(a.date).localeCompare(
                    String(b.date)
                  )
                )

            const completedDays =
              validRecords.filter(
                (record) =>
                  record?.completed === true
              ).length

            const participantStartDate =
              data?.startDate ||
              validRecords[0]?.date ||
              null

            const completionRate =
              TOTAL_DAYS > 0
                ? (completedDays / TOTAL_DAYS) * 100
                : 0

            const getStudyDay = (record) => {
              if (
                Number.isFinite(
                  Number(record?.studyDay)
                )
              ) {
                return Number(record.studyDay)
              }

              if (
                !participantStartDate ||
                !record?.date
              ) {
                return null
              }

              const start =
                new Date(
                  `${participantStartDate}T00:00:00`
                )

              const current =
                new Date(
                  `${record.date}T00:00:00`
                )

              const diff =
                Math.round(
                  (current - start) /
                    (1000 * 60 * 60 * 24)
                ) + 1

              return diff
            }

            const getEvaluationRecord = (
              evaluationDay
            ) => {
              return (
                validRecords.find(
                  (record) =>
                    getStudyDay(record) ===
                    evaluationDay
                ) || null
              )
            }

            const getChange = (
              preValue,
              postValue
            ) => {
              const pre = Number(preValue)
              const post = Number(postValue)

              if (
                !Number.isFinite(pre) ||
                !Number.isFinite(post)
              ) {
                return null
              }

              return post - pre
            }

            const getMCID = (change) => {
              if (change === null) {
                return false
              }

              return change <= -5
            }

            const renderEvaluationDay = (
              evaluationDay
            ) => {
              const record =
                getEvaluationRecord(
                  evaluationDay
                )

              if (!record) {
                return (
                  <div
                    style={{
                      color: '#94a3b8',
                      fontSize: '15px',
                      lineHeight: '1.7',
                    }}
                  >
                    尚無資料
                  </div>
                )
              }

              const sbpChange = getChange(
                record.pre?.sbp,
                record.post?.sbp
              )

              const dbpChange = getChange(
                record.pre?.dbp,
                record.post?.dbp
              )

              const hrChange = getChange(
                record.pre?.hr,
                record.post?.hr
              )

              const formatChange = (
                value
              ) => {
                if (value === null) {
                  return '—'
                }

                return `${
                  value > 0 ? '+' : ''
                }${value}`
              }

              const sbpMCID =
                getMCID(sbpChange)

              const dbpMCID =
                getMCID(dbpChange)

              return (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    lineHeight: '1.5',
                    fontSize: '15px',
                  }}
                >
                  <div>
                    <strong>SBP</strong>{' '}
                    {formatChange(sbpChange)}
                    <span
                      style={{
                        marginLeft: '4px',
                        color: sbpMCID
                          ? '#15803d'
                          : '#94a3b8',
                        fontWeight: '700',
                      }}
                    >
                      {sbpMCID
                        ? '✓'
                        : ''}
                    </span>
                  </div>

                  <div>
                    <strong>DBP</strong>{' '}
                    {formatChange(dbpChange)}
                    <span
                      style={{
                        marginLeft: '4px',
                        color: dbpMCID
                          ? '#15803d'
                          : '#94a3b8',
                        fontWeight: '700',
                      }}
                    >
                      {dbpMCID
                        ? '✓'
                        : ''}
                    </span>
                  </div>

                  <div>
                    <strong>HR</strong>{' '}
                    {formatChange(hrChange)}
                  </div>

                  <div
                    style={{
                      marginTop: '2px',
                      fontSize: '13px',
                      color: '#64748b',
                    }}
                  >
                    MCID：
                    {sbpMCID ||
                    dbpMCID
                      ? '達成'
                      : '未達'}
                  </div>
                </div>
              )
            }

            return (
              <tr
                key={id}
                style={{
                  borderBottom:
                    '1px solid #e2e8f0',
                }}
              >
                <td
                  style={{
                    padding: '14px 10px',
                    fontWeight: '700',
                    color: '#155e75',
                    verticalAlign: 'top',
                  }}
                >
                  {formatParticipantId(id)}
                </td>

                <td
                  style={{
                    padding: '14px 10px',
                    textAlign: 'center',
                    fontWeight: '700',
                    verticalAlign: 'top',
                  }}
                >
                  {completionRate.toFixed(1)}%
                </td>

                <td
                  style={{
                    padding: '14px 10px',
                    textAlign: 'center',
                    verticalAlign: 'top',
                  }}
                >
                  {renderEvaluationDay(1)}
                </td>

                <td
                  style={{
                    padding: '14px 10px',
                    textAlign: 'center',
                    verticalAlign: 'top',
                  }}
                >
                  {renderEvaluationDay(14)}
                </td>

                <td
                  style={{
                    padding: '14px 10px',
                    textAlign: 'center',
                    verticalAlign: 'top',
                  }}
                >
                  {renderEvaluationDay(28)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )}
</div>

            <div
  style={{
    marginTop: '16px',
    padding: '16px',
    borderRadius: '16px',
    background: 'rgba(255,255,255,0.65)',
    border: '1px solid rgba(255,255,255,0.9)',
  }}
>
  <label
    htmlFor="participant-select"
    style={{
      display: 'block',
      fontWeight: '700',
      fontSize: '20px',
      marginBottom: '8px',
      color: '#155e75',
    }}
  >
    受試者選擇
  </label>

  <div
  style={{
    position: 'relative',
    width: '100%',
  }}
>
  <button
    type="button"
    onClick={() =>
      setParticipantMenuOpen((prev) => !prev)
    }
    style={{
      width: '100%',
      minHeight: '56px',
      padding: '12px 16px',
      borderRadius: '12px',
      border: '2px solid #b6d9e8',
      background: '#ffffff',
      color: '#155e75',
      fontSize: '22px',
      fontWeight: '700',
      textAlign: 'left',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}
  >
    <span>
      {formatParticipantId(selectedParticipant)}
    </span>

    <span
      style={{
        fontSize: '22px',
        lineHeight: 1,
      }}
    >
      {participantMenuOpen ? '▲' : '▼'}
    </span>
  </button>

  {participantMenuOpen && (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        right: 0,
        zIndex: 1000,
        maxHeight: '320px',
        overflowY: 'auto',
        background: '#ffffff',
        border: '2px solid #b6d9e8',
        borderRadius: '12px',
        boxShadow: '0 8px 20px rgba(0,0,0,0.15)',
        padding: '6px',
      }}
    >
      {participantIds.map((id) => {
        const displayId = formatParticipantId(id)
        const isSelected =
          String(id) === String(selectedParticipant)

        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              setSelectedParticipant(id)
              setParticipantMenuOpen(false)
            }}
            style={{
              width: '100%',
              minHeight: '52px',
              padding: '10px 14px',
              border: 'none',
              borderRadius: '8px',
              background: isSelected
                ? '#dff3fa'
                : '#ffffff',
              color: '#155e75',
              fontSize: '20px',
              fontWeight: isSelected
                ? '700'
                : '600',
              textAlign: 'left',
              cursor: 'pointer',
              marginBottom: '3px',
            }}
          >
            {displayId}
          </button>
        )
      })}
    </div>
  )}
</div>
</div>

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
              <strong>{selectedParticipant}</strong>
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

  const immediateSBP =
    record?.pre && record?.post
      ? getChange(record.pre.sbp, record.post.sbp)
      : null

  const immediateDBP =
    record?.pre && record?.post
      ? getChange(record.pre.dbp, record.post.dbp)
      : null

  const immediateHR =
    record?.pre && record?.post
      ? getChange(record.pre.hr, record.post.hr)
      : null

  const post30SBP =
    record?.pre && record?.post30
      ? getChange(record.pre.sbp, record.post30.sbp)
      : null

  const post30DBP =
    record?.pre && record?.post30
      ? getChange(record.pre.dbp, record.post30.dbp)
      : null

  const post30HR =
    record?.pre && record?.post30
      ? getChange(record.pre.hr, record.post30.hr)
      : null

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

      {/* 訓練後立即變化 */}
      <div
        style={{
          marginTop: '12px',
          padding: '10px 12px',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.35)',
        }}
      >
        <strong>訓練後立即變化</strong>

        <div style={{ marginTop: '6px' }}>
          SBP：
          <strong>
            {immediateSBP !== null
              ? `${immediateSBP > 0 ? '+' : ''}${immediateSBP} mmHg`
              : '資料不足'}
          </strong>
        </div>

        <div>
          DBP：
          <strong>
            {immediateDBP !== null
              ? `${immediateDBP > 0 ? '+' : ''}${immediateDBP} mmHg`
              : '資料不足'}
          </strong>
        </div>

        <div>
          HR：
          <strong>
            {immediateHR !== null
              ? `${immediateHR > 0 ? '+' : ''}${immediateHR} bpm`
              : '資料不足'}
          </strong>
        </div>
      </div>

      {/* 30 分鐘後變化 */}
      <div
        style={{
          marginTop: '10px',
          padding: '10px 12px',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.35)',
        }}
      >
        <strong>30 分鐘後變化</strong>

        <div style={{ marginTop: '6px' }}>
          SBP：
          <strong>
            {post30SBP !== null
              ? `${post30SBP > 0 ? '+' : ''}${post30SBP} mmHg`
              : '資料不足'}
          </strong>
        </div>

        <div>
          DBP：
          <strong>
            {post30DBP !== null
              ? `${post30DBP > 0 ? '+' : ''}${post30DBP} mmHg`
              : '資料不足'}
          </strong>
        </div>

        <div>
          HR：
          <strong>
            {post30HR !== null
              ? `${post30HR > 0 ? '+' : ''}${post30HR} bpm`
              : '資料不足'}
          </strong>
        </div>
      </div>

      <div
        style={{
          marginTop: '8px',
          fontSize: '13px',
          opacity: 0.8,
        }}
      >
        負值代表下降，正值代表上升。
      </div>

    </div>
  )
}


/* =========================================================
   變化量小卡
   ========================================================= */

function ChangeItem({ label, value, unit }) {
  if (value === null) {
    return (
      <div className="change-item">
        <span>{label}</span>
        <strong>—</strong>
        <small>資料不足</small>
      </div>
    )
  }

  const displayValue =
    value > 0
      ? `+${formatNumber(value)}`
      : formatNumber(value)

  return (
    <div className="change-item">
      <span>{label}</span>

      <strong>
        {displayValue}
      </strong>

      <small>
        {unit}
      </small>
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
